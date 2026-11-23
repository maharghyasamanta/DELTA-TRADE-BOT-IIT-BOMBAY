/**
 * Pure, deterministic detector evaluation engine for auditing whether causal
 * Phase 2/3 guardrail alerts preceded large historical price moves ("events")
 * and measuring false-alarm rates against a deterministic circular-shift
 * baseline.
 *
 * Strictly descriptive historical measurement — NOT a trading signal or
 * predictive model. Zero network calls, zero randomness, zero lookahead.
 */

import {
  evaluateGuardrails,
  type GuardrailDecision,
  type GuardrailOptions,
} from './guardrails';
import {
  computeRegimeSeries,
  type CandlePoint,
  type RegimeOptions,
} from './regime';

/**
 * Forward return horizon H (bars) over which a large move ("event") is measured.
 * 8 bars equals 2 hours on 15m candles and 8 hours on 1h candles.
 */
export const DEFAULT_EVENT_HORIZON_BARS = 8;

/**
 * Spike multiplier K applied to the causal trailing rolling stdev of H-bar
 * returns. 2.5 sigma flags tail excursions beyond typical local dispersion
 * without tuning to any specific asset.
 */
export const DEFAULT_EVENT_SIGMA_K = 2.5;

/**
 * Lookback window L (bars) prior to and including an event start bar in which
 * an alert counts as a hit for lead-time and recall measurement.
 */
export const DEFAULT_LEAD_LOOKBACK_BARS = 12;

/**
 * Causal trailing window (bars) of H-bar returns used to estimate the rolling
 * H-bar return standard deviation at bar i (using only bars <= i).
 */
export const DEFAULT_SPIKE_VOL_LOOKBACK_BARS = 96;

/**
 * Minimum number of causal H-bar return samples required before bar i can be
 * evaluated for a spike event, avoiding unstable early-history stdev estimates.
 */
export const DEFAULT_SPIKE_MIN_RETURN_SAMPLES = 20;

/**
 * Minimum number of detected spike events required before reporting recall or
 * lead-time summary percentages; below this, metrics return null.
 */
export const DEFAULT_MIN_SAMPLE_EVENTS = 20;

/**
 * Minimum number of merged alert episodes required before reporting precision
 * or false-alarm percentages; below this, metrics return null.
 */
export const DEFAULT_MIN_SAMPLE_EPISODES = 20;

/**
 * Fixed deterministic percentage offsets (~every 7% of series length) used to
 * circularly shift the boolean alert vector for the chance-rate baseline.
 */
export const DEFAULT_CIRCULAR_SHIFT_PERCENTS: readonly number[] = [
  7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 84, 91,
] as const;

/**
 * Standard normal 97.5th percentile z-score for 95% Wilson score intervals.
 */
const WILSON_Z_95 = 1.959963984540054;

const ZERO_EPSILON = 1e-12;

export interface EvaluationOptions {
  /** Forward horizon H in bars (default: DEFAULT_EVENT_HORIZON_BARS = 8). */
  horizonBars?: number;
  /** Threshold multiplier K * rolling stdev (default: DEFAULT_EVENT_SIGMA_K = 2.5). */
  sigmaMultiplier?: number;
  /** Lookback window L in bars before event start (default: DEFAULT_LEAD_LOOKBACK_BARS = 12). */
  leadLookbackBars?: number;
  /** Trailing window of causal H-bar returns for stdev (default: 96). */
  spikeVolLookbackBars?: number;
  /** Minimum causal H-bar return samples before flagging events (default: 20). */
  spikeMinSamples?: number;
  /** Minimum events required to report non-null metrics (default: 20). */
  minSampleEvents?: number;
  /** Minimum alert episodes required to report non-null metrics (default: 20). */
  minSampleEpisodes?: number;
  /** Fixed percentage offsets for circular-shift baseline (default: every 7%). */
  circularShiftPercents?: readonly number[];
  /** Explicit bar spacing in minutes (otherwise inferred from candle timestamps). */
  barIntervalMinutes?: number;
  /** Optional regime overrides (defaults to unchanged Phase 2 constants). */
  regimeOptions?: RegimeOptions;
  /** Optional guardrail overrides (defaults to unchanged Phase 3 constants). */
  guardrailOptions?: GuardrailOptions;
}

export interface ResolvedEvaluationOptions {
  horizonBars: number;
  sigmaMultiplier: number;
  leadLookbackBars: number;
  spikeVolLookbackBars: number;
  spikeMinSamples: number;
  minSampleEvents: number;
  minSampleEpisodes: number;
  circularShiftPercents: readonly number[];
  barIntervalMinutes: number;
}

export interface CausalGuardrailBar {
  barIndex: number;
  time: number;
  close: number;
  score: number | null;
  volZ: number | null;
  trend: number | null;
  changePointsInWindow: number;
  lastChangePointAgeBars: number | null;
  decision: GuardrailDecision;
  firedRules: readonly string[];
  reasons: readonly string[];
  isAlert: boolean;
  isPauseAlert: boolean;
}

export interface SpikeEvent {
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
  forwardReturn: number;
  absForwardReturn: number;
  trailingSigmaH: number;
  thresholdReturn: number;
}

export interface AlertEpisode {
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
  lengthBars: number;
  isTrueEpisode: boolean;
  matchedEventStartBar: number | null;
}

export interface EventMatchDetail {
  event: SpikeEvent;
  hit: boolean;
  earliestAlertBar: number | null;
  earliestAlertTime: number | null;
  leadTimeBars: number | null;
  leadTimeMinutes: number | null;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
  point: number;
  successes: number;
  trials: number;
}

export interface LeadTimeSummary {
  median: number;
  q25: number;
  q75: number;
  iqr: number;
  count: number;
}

export interface BaselineRangeStats {
  mean: number;
  min: number;
  max: number;
}

export interface CircularShiftBaselineSummary {
  shiftCount: number;
  offsetsBars: readonly number[];
  recall: BaselineRangeStats | null;
  precision: BaselineRangeStats | null;
}

export interface DetectorMetricsBlock {
  barCount: number;
  startTime: number | null;
  endTime: number | null;
  eventCount: number;
  alertBarCount: number;
  alertEpisodeCount: number;
  hits: number;
  missedEvents: number;
  trueEpisodes: number;
  falseAlarms: number;
  insufficientSample: boolean;
  insufficientSampleReason: string | null;
  recall: number | null;
  precision: number | null;
  falseAlarmsPer100Bars: number | null;
  wilsonRecall95: WilsonInterval | null;
  wilsonPrecision95: WilsonInterval | null;
  leadTimeBars: LeadTimeSummary | null;
  leadTimeMinutes: LeadTimeSummary | null;
  baseline: CircularShiftBaselineSummary | null;
}

export interface DetectorScopeReport {
  allAlerts: DetectorMetricsBlock;
  pauseOnly: DetectorMetricsBlock;
}

export interface DetectorEvaluationReport {
  options: ResolvedEvaluationOptions;
  candleCount: number;
  startTime: number | null;
  endTime: number | null;
  splitIndex: number;
  bars: ReadonlyArray<CausalGuardrailBar>;
  events: ReadonlyArray<SpikeEvent>;
  episodesAllAlerts: ReadonlyArray<AlertEpisode>;
  episodesPauseOnly: ReadonlyArray<AlertEpisode>;
  eventMatchesAllAlerts: ReadonlyArray<EventMatchDetail>;
  eventMatchesPauseOnly: ReadonlyArray<EventMatchDetail>;
  whole: DetectorScopeReport;
  firstHalf: DetectorScopeReport;
  secondHalf: DetectorScopeReport;
}

function sampleStdDev(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
  }
  const mean = sum / n;
  let sqDiffSum = 0;
  for (let i = 0; i < n; i += 1) {
    const diff = values[i] - mean;
    sqDiffSum += diff * diff;
  }
  return Math.sqrt(sqDiffSum / (n - 1));
}

function inferBarIntervalMinutes(candles: readonly CandlePoint[]): number {
  if (candles.length < 2) return 15;
  const diffsSec: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const d = candles[i].time - candles[i - 1].time;
    if (Number.isFinite(d) && d > 0) {
      diffsSec.push(d);
    }
  }
  if (diffsSec.length === 0) return 15;
  diffsSec.sort((a, b) => a - b);
  const mid = Math.floor(diffsSec.length / 2);
  const medianSec =
    diffsSec.length % 2 === 0 ? (diffsSec[mid - 1] + diffsSec[mid]) / 2 : diffsSec[mid];
  return Math.max(1, medianSec / 60);
}

export function resolveEvaluationOptions(
  candles: readonly CandlePoint[],
  raw?: EvaluationOptions,
): ResolvedEvaluationOptions {
  return {
    horizonBars: Math.max(1, Math.floor(raw?.horizonBars ?? DEFAULT_EVENT_HORIZON_BARS)),
    sigmaMultiplier:
      raw?.sigmaMultiplier !== undefined && Number.isFinite(raw.sigmaMultiplier) && raw.sigmaMultiplier > 0
        ? raw.sigmaMultiplier
        : DEFAULT_EVENT_SIGMA_K,
    leadLookbackBars: Math.max(
      0,
      Math.floor(raw?.leadLookbackBars ?? DEFAULT_LEAD_LOOKBACK_BARS),
    ),
    spikeVolLookbackBars: Math.max(
      2,
      Math.floor(raw?.spikeVolLookbackBars ?? DEFAULT_SPIKE_VOL_LOOKBACK_BARS),
    ),
    spikeMinSamples: Math.max(
      2,
      Math.floor(raw?.spikeMinSamples ?? DEFAULT_SPIKE_MIN_RETURN_SAMPLES),
    ),
    minSampleEvents: Math.max(
      0,
      Math.floor(raw?.minSampleEvents ?? DEFAULT_MIN_SAMPLE_EVENTS),
    ),
    minSampleEpisodes: Math.max(
      0,
      Math.floor(raw?.minSampleEpisodes ?? DEFAULT_MIN_SAMPLE_EPISODES),
    ),
    circularShiftPercents:
      raw?.circularShiftPercents && raw.circularShiftPercents.length > 0
        ? raw.circularShiftPercents
        : DEFAULT_CIRCULAR_SHIFT_PERCENTS,
    barIntervalMinutes:
      raw?.barIntervalMinutes !== undefined &&
      Number.isFinite(raw.barIntervalMinutes) &&
      raw.barIntervalMinutes > 0
        ? raw.barIntervalMinutes
        : inferBarIntervalMinutes(candles),
  };
}

/**
 * Compute Wilson 95% score confidence interval for k successes out of n trials.
 * Returns null if n <= 0.
 */
export function wilsonInterval95(successes: number, trials: number): WilsonInterval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) {
    return null;
  }
  const k = Math.min(trials, Math.max(0, successes));
  const n = trials;
  const p = k / n;
  const z = WILSON_Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;

  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    point: p,
    successes: k,
    trials: n,
  };
}

function linearQuantile(sortedValues: readonly number[], q: number): number {
  const n = sortedValues.length;
  if (n === 1) return sortedValues[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  const frac = pos - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

function summarizeLeadTimes(
  values: readonly number[],
  scale = 1,
): LeadTimeSummary | null {
  if (values.length === 0) return null;
  const sorted = values.map((v) => v * scale).sort((a, b) => a - b);
  const q25 = linearQuantile(sorted, 0.25);
  const median = linearQuantile(sorted, 0.5);
  const q75 = linearQuantile(sorted, 0.75);
  return {
    median,
    q25,
    q75,
    iqr: q75 - q25,
    count: sorted.length,
  };
}

/**
 * Compute the causal per-bar regime and guardrail series for candles[0..N-1].
 * Every bar i depends strictly on candles[0..i] (zero lookahead).
 */
export function computeCausalGuardrailsSeries(
  candles: readonly CandlePoint[],
  options?: Pick<EvaluationOptions, 'regimeOptions' | 'guardrailOptions'>,
): CausalGuardrailBar[] {
  const regimeResult = computeRegimeSeries(candles, options?.regimeOptions);
  const requiredBars = Math.max(
    regimeResult.meta.requiredBarsForVolZ,
    regimeResult.meta.requiredBarsForTrend,
  );
  const { markers, series } = regimeResult;

  const bars: CausalGuardrailBar[] = new Array<CausalGuardrailBar>(candles.length);
  let markerCursor = 0;
  let lastMarkerBar: number | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    while (markerCursor < markers.length && markers[markerCursor].barIndex <= i) {
      lastMarkerBar = markers[markerCursor].barIndex;
      markerCursor += 1;
    }

    const point = series[i];
    const lastChangePointAgeBars = lastMarkerBar !== null ? i - lastMarkerBar : null;
    const evaluation = evaluateGuardrails(
      {
        score: point.score,
        volZ: point.volZ,
        trend: point.trend,
        changePointsInWindow: markerCursor,
        lastChangePointAgeBars,
        candleCount: i + 1,
        requiredBars,
      },
      options?.guardrailOptions,
    );

    bars[i] = {
      barIndex: i,
      time: candles[i].time,
      close: candles[i].close,
      score: evaluation.inputs.score,
      volZ: evaluation.inputs.volZ,
      trend: evaluation.inputs.trend,
      changePointsInWindow: evaluation.inputs.changePointsInWindow,
      lastChangePointAgeBars: evaluation.inputs.lastChangePointAgeBars,
      decision: evaluation.decision,
      firedRules: evaluation.firedRules,
      reasons: evaluation.reasons,
      isAlert: evaluation.decision === 'PAUSE' || evaluation.decision === 'REDUCE_SIZE',
      isPauseAlert: evaluation.decision === 'PAUSE',
    };
  }

  return bars;
}

/**
 * Identify non-overlapping historical spike events.
 * Bar i starts an event if |close[i + H] / close[i] - 1| > K * stdev(H-bar returns <= i),
 * where the trailing stdev at bar i uses ONLY candles with index <= i.
 * Overlapping events (starting within H bars of the previous event start) are skipped.
 */
export function detectSpikeEvents(
  candles: readonly CandlePoint[],
  resolved: Pick<
    ResolvedEvaluationOptions,
    'horizonBars' | 'sigmaMultiplier' | 'spikeVolLookbackBars' | 'spikeMinSamples'
  >,
): SpikeEvent[] {
  const n = candles.length;
  const { horizonBars: h, sigmaMultiplier: k, spikeVolLookbackBars: w, spikeMinSamples: minSamples } =
    resolved;

  if (n <= h + minSamples) {
    return [];
  }

  // Causal H-bar simple returns at each bar t: (close[t] / close[t - H]) - 1
  const causalHReturns = new Array<number | null>(n).fill(null);
  for (let t = h; t < n; t += 1) {
    const prev = candles[t - h].close;
    const curr = candles[t].close;
    if (Number.isFinite(prev) && prev > 0 && Number.isFinite(curr) && curr > 0) {
      const r = curr / prev - 1;
      if (Number.isFinite(r)) {
        causalHReturns[t] = r;
      }
    }
  }

  const events: SpikeEvent[] = [];
  let lastEventStartBar: number | null = null;

  for (let i = h; i < n - h; i += 1) {
    if (lastEventStartBar !== null && i - lastEventStartBar < h) {
      continue;
    }

    const startClose = candles[i].close;
    const endClose = candles[i + h].close;
    if (
      !Number.isFinite(startClose) ||
      startClose <= 0 ||
      !Number.isFinite(endClose) ||
      endClose <= 0
    ) {
      continue;
    }

    const fwdReturn = endClose / startClose - 1;
    if (!Number.isFinite(fwdReturn)) {
      continue;
    }

    const windowStart = Math.max(h, i - w + 1);
    const trailingReturns: number[] = [];
    for (let t = windowStart; t <= i; t += 1) {
      const r = causalHReturns[t];
      if (r !== null) {
        trailingReturns.push(r);
      }
    }

    if (trailingReturns.length < minSamples) {
      continue;
    }

    const sigmaH = sampleStdDev(trailingReturns);
    if (sigmaH === null || sigmaH <= ZERO_EPSILON) {
      continue;
    }

    const thresholdReturn = k * sigmaH;
    const absForwardReturn = Math.abs(fwdReturn);
    if (absForwardReturn > thresholdReturn) {
      events.push({
        startBar: i,
        endBar: i + h,
        startTime: candles[i].time,
        endTime: candles[i + h].time,
        forwardReturn: fwdReturn,
        absForwardReturn,
        trailingSigmaH: sigmaH,
        thresholdReturn,
      });
      lastEventStartBar = i;
    }
  }

  return events;
}

/**
 * Merge consecutive true alert bars inside [sliceStart, sliceEnd) into alert episodes
 * and classify each episode as a true episode or false alarm based on whether any event
 * starts within [episode.startBar, episode.startBar + H].
 */
export function buildAlertEpisodes(
  alerts: readonly boolean[],
  times: readonly number[],
  events: readonly SpikeEvent[],
  horizonBars: number,
  sliceStart = 0,
  sliceEnd = alerts.length,
): AlertEpisode[] {
  const episodes: AlertEpisode[] = [];
  let currentStart: number | null = null;

  const flushEpisode = (startBar: number, endBar: number) => {
    let matchedEventStartBar: number | null = null;
    for (let eIdx = 0; eIdx < events.length; eIdx += 1) {
      const evStart = events[eIdx].startBar;
      if (evStart >= startBar && evStart <= startBar + horizonBars) {
        matchedEventStartBar = evStart;
        break;
      }
    }
    episodes.push({
      startBar,
      endBar,
      startTime: times[startBar] ?? 0,
      endTime: times[endBar] ?? 0,
      lengthBars: endBar - startBar + 1,
      isTrueEpisode: matchedEventStartBar !== null,
      matchedEventStartBar,
    });
  };

  for (let i = sliceStart; i < sliceEnd; i += 1) {
    if (alerts[i]) {
      if (currentStart === null) {
        currentStart = i;
      }
    } else if (currentStart !== null) {
      flushEpisode(currentStart, i - 1);
      currentStart = null;
    }
  }
  if (currentStart !== null) {
    flushEpisode(currentStart, sliceEnd - 1);
  }

  return episodes;
}

/**
 * Match each event inside [sliceStart, sliceEnd) against the earliest alert bar inside
 * [max(sliceStart, event.startBar - L), event.startBar].
 */
export function matchEventsToAlerts(
  alerts: readonly boolean[],
  times: readonly number[],
  events: readonly SpikeEvent[],
  leadLookbackBars: number,
  barIntervalMinutes: number,
  sliceStart = 0,
  sliceEnd = alerts.length,
): EventMatchDetail[] {
  const details: EventMatchDetail[] = [];

  for (let eIdx = 0; eIdx < events.length; eIdx += 1) {
    const ev = events[eIdx];
    if (ev.startBar < sliceStart || ev.startBar >= sliceEnd) {
      continue;
    }
    const winStart = Math.max(sliceStart, ev.startBar - leadLookbackBars);
    let earliestAlertBar: number | null = null;
    for (let b = winStart; b <= ev.startBar; b += 1) {
      if (alerts[b]) {
        earliestAlertBar = b;
        break;
      }
    }
    const leadTimeBars = earliestAlertBar !== null ? ev.startBar - earliestAlertBar : null;
    details.push({
      event: ev,
      hit: earliestAlertBar !== null,
      earliestAlertBar,
      earliestAlertTime: earliestAlertBar !== null ? (times[earliestAlertBar] ?? null) : null,
      leadTimeBars,
      leadTimeMinutes: leadTimeBars !== null ? leadTimeBars * barIntervalMinutes : null,
    });
  }

  return details;
}

export function computeCircularShiftBaseline(
  alertsSlice: readonly boolean[],
  timesSlice: readonly number[],
  eventsSlice: readonly SpikeEvent[],
  sliceOffset: number,
  resolved: ResolvedEvaluationOptions,
): CircularShiftBaselineSummary | null {
  const n = alertsSlice.length;
  if (n < 2 || eventsSlice.length === 0) {
    return null;
  }

  // Re-index events relative to [0 .. n - 1]
  const localEvents: SpikeEvent[] = eventsSlice.map((ev) => ({
    ...ev,
    startBar: ev.startBar - sliceOffset,
    endBar: ev.endBar - sliceOffset,
  }));

  const uniqueShifts: number[] = [];
  const seen = new Set<number>();
  for (const pct of resolved.circularShiftPercents) {
    const rawShift = Math.round((pct / 100) * n);
    if (rawShift > 0 && rawShift < n && !seen.has(rawShift)) {
      seen.add(rawShift);
      uniqueShifts.push(rawShift);
    }
  }

  if (uniqueShifts.length === 0) {
    return null;
  }

  const recalls: number[] = [];
  const precisions: number[] = [];

  for (const shift of uniqueShifts) {
    const shiftedAlerts = new Array<boolean>(n);
    for (let j = 0; j < n; j += 1) {
      shiftedAlerts[(j + shift) % n] = alertsSlice[j];
    }

    const shiftedEpisodes = buildAlertEpisodes(
      shiftedAlerts,
      timesSlice,
      localEvents,
      resolved.horizonBars,
      0,
      n,
    );
    const shiftedMatches = matchEventsToAlerts(
      shiftedAlerts,
      timesSlice,
      localEvents,
      resolved.leadLookbackBars,
      resolved.barIntervalMinutes,
      0,
      n,
    );

    const hits = shiftedMatches.reduce((acc, m) => acc + (m.hit ? 1 : 0), 0);
    recalls.push(hits / localEvents.length);

    if (shiftedEpisodes.length > 0) {
      const trueEps = shiftedEpisodes.reduce((acc, ep) => acc + (ep.isTrueEpisode ? 1 : 0), 0);
      precisions.push(trueEps / shiftedEpisodes.length);
    }
  }

  const summarize = (vals: readonly number[]): BaselineRangeStats | null => {
    if (vals.length === 0) return null;
    let sum = 0;
    let min = vals[0];
    let max = vals[0];
    for (let i = 0; i < vals.length; i += 1) {
      const v = vals[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { mean: sum / vals.length, min, max };
  };

  return {
    shiftCount: uniqueShifts.length,
    offsetsBars: uniqueShifts,
    recall: summarize(recalls),
    precision: summarize(precisions),
  };
}

function evaluateSlice(
  alerts: readonly boolean[],
  times: readonly number[],
  events: readonly SpikeEvent[],
  sliceStart: number,
  sliceEnd: number,
  resolved: ResolvedEvaluationOptions,
): {
  metrics: DetectorMetricsBlock;
  episodes: AlertEpisode[];
  matches: EventMatchDetail[];
} {
  const barCount = Math.max(0, sliceEnd - sliceStart);
  const startTime = barCount > 0 ? (times[sliceStart] ?? null) : null;
  const endTime = barCount > 0 ? (times[sliceEnd - 1] ?? null) : null;

  const sliceEvents = events.filter((ev) => ev.startBar >= sliceStart && ev.startBar < sliceEnd);
  const episodes = buildAlertEpisodes(
    alerts,
    times,
    sliceEvents,
    resolved.horizonBars,
    sliceStart,
    sliceEnd,
  );
  const matches = matchEventsToAlerts(
    alerts,
    times,
    sliceEvents,
    resolved.leadLookbackBars,
    resolved.barIntervalMinutes,
    sliceStart,
    sliceEnd,
  );

  let alertBarCount = 0;
  for (let i = sliceStart; i < sliceEnd; i += 1) {
    if (alerts[i]) alertBarCount += 1;
  }

  const eventCount = sliceEvents.length;
  const alertEpisodeCount = episodes.length;
  const hits = matches.reduce((acc, m) => acc + (m.hit ? 1 : 0), 0);
  const missedEvents = eventCount - hits;
  const trueEpisodes = episodes.reduce((acc, ep) => acc + (ep.isTrueEpisode ? 1 : 0), 0);
  const falseAlarms = alertEpisodeCount - trueEpisodes;

  const insufficientSample =
    eventCount < resolved.minSampleEvents || alertEpisodeCount < resolved.minSampleEpisodes;

  if (insufficientSample) {
    const parts: string[] = [];
    if (eventCount < resolved.minSampleEvents) {
      parts.push(`events ${eventCount} < ${resolved.minSampleEvents}`);
    }
    if (alertEpisodeCount < resolved.minSampleEpisodes) {
      parts.push(`alert episodes ${alertEpisodeCount} < ${resolved.minSampleEpisodes}`);
    }
    return {
      metrics: {
        barCount,
        startTime,
        endTime,
        eventCount,
        alertBarCount,
        alertEpisodeCount,
        hits,
        missedEvents,
        trueEpisodes,
        falseAlarms,
        insufficientSample: true,
        insufficientSampleReason: `Insufficient sample (${parts.join('; ')})`,
        recall: null,
        precision: null,
        falseAlarmsPer100Bars: null,
        wilsonRecall95: null,
        wilsonPrecision95: null,
        leadTimeBars: null,
        leadTimeMinutes: null,
        baseline: null,
      },
      episodes,
      matches,
    };
  }

  const recall = eventCount > 0 ? hits / eventCount : null;
  const precision = alertEpisodeCount > 0 ? trueEpisodes / alertEpisodeCount : null;
  const falseAlarmsPer100Bars = barCount > 0 ? (falseAlarms / barCount) * 100 : null;
  const leadBarsValues = matches
    .map((m) => m.leadTimeBars)
    .filter((v): v is number => v !== null);

  const baseline = computeCircularShiftBaseline(
    alerts.slice(sliceStart, sliceEnd),
    times.slice(sliceStart, sliceEnd),
    sliceEvents,
    sliceStart,
    resolved,
  );

  return {
    metrics: {
      barCount,
      startTime,
      endTime,
      eventCount,
      alertBarCount,
      alertEpisodeCount,
      hits,
      missedEvents,
      trueEpisodes,
      falseAlarms,
      insufficientSample: false,
      insufficientSampleReason: null,
      recall,
      precision,
      falseAlarmsPer100Bars,
      wilsonRecall95: wilsonInterval95(hits, eventCount),
      wilsonPrecision95: wilsonInterval95(trueEpisodes, alertEpisodeCount),
      leadTimeBars: summarizeLeadTimes(leadBarsValues, 1),
      leadTimeMinutes: summarizeLeadTimes(leadBarsValues, resolved.barIntervalMinutes),
      baseline,
    },
    episodes,
    matches,
  };
}

/**
 * Evaluate causal guardrail alerts against historical spike events across
 * the whole sample, first half, and second half, reporting both combined
 * (PAUSE | REDUCE_SIZE) and PAUSE-only alerts.
 */
export function evaluateDetector(
  candles: readonly CandlePoint[],
  rawOptions?: EvaluationOptions,
): DetectorEvaluationReport {
  const options = resolveEvaluationOptions(candles, rawOptions);
  const bars = computeCausalGuardrailsSeries(candles, {
    regimeOptions: rawOptions?.regimeOptions,
    guardrailOptions: rawOptions?.guardrailOptions,
  });
  const events = detectSpikeEvents(candles, options);

  const n = bars.length;
  const times = bars.map((b) => b.time);
  const allAlerts = bars.map((b) => b.isAlert);
  const pauseAlerts = bars.map((b) => b.isPauseAlert);
  const splitIndex = Math.floor(n / 2);

  const wholeAll = evaluateSlice(allAlerts, times, events, 0, n, options);
  const wholePause = evaluateSlice(pauseAlerts, times, events, 0, n, options);

  const firstAll = evaluateSlice(allAlerts, times, events, 0, splitIndex, options);
  const firstPause = evaluateSlice(pauseAlerts, times, events, 0, splitIndex, options);

  const secondAll = evaluateSlice(allAlerts, times, events, splitIndex, n, options);
  const secondPause = evaluateSlice(pauseAlerts, times, events, splitIndex, n, options);

  return {
    options,
    candleCount: n,
    startTime: n > 0 ? bars[0].time : null,
    endTime: n > 0 ? bars[n - 1].time : null,
    splitIndex,
    bars,
    events,
    episodesAllAlerts: wholeAll.episodes,
    episodesPauseOnly: wholePause.episodes,
    eventMatchesAllAlerts: wholeAll.matches,
    eventMatchesPauseOnly: wholePause.matches,
    whole: {
      allAlerts: wholeAll.metrics,
      pauseOnly: wholePause.metrics,
    },
    firstHalf: {
      allAlerts: firstAll.metrics,
      pauseOnly: firstPause.metrics,
    },
    secondHalf: {
      allAlerts: secondAll.metrics,
      pauseOnly: secondPause.metrics,
    },
  };
}
