/**
 * Pure, deterministic market-regime descriptive statistics computed solely from
 * loaded OHLCV candles. No side effects, no network calls, no React/server deps.
 *
 * All metrics are descriptive summaries over trailing candle windows — never
 * predictive signals.
 */

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 20 bars balances noise smoothing against responsiveness (~5h on 15m bars,
 * ~1 trading month on 1D equity bars).
 */
export const DEFAULT_VOL_WINDOW = 20;

/**
 * 60 rolling volatility windows provide an empirical baseline dispersion while
 * remaining computable inside standard 24h 15m (96-bar) and 100-bar daily loads.
 */
export const DEFAULT_VOL_LOOKBACK = 60;

/**
 * 20 bars matches DEFAULT_VOL_WINDOW so trend strength and volatility describe
 * the same local horizon.
 */
export const DEFAULT_TREND_WINDOW = 20;

/**
 * 20-bar trailing log-return stdev used to standardize returns in CUSUM.
 */
export const DEFAULT_CUSUM_VOL_WINDOW = 20;

/**
 * Reference slack k = 0.5 standard deviations (standard two-sided CUSUM
 * setting to ignore normal +/-0.5 sigma drift while accumulating 1+ sigma shifts).
 */
export const DEFAULT_CUSUM_K = 0.5;

/**
 * Decision threshold h = 5.0 standardized units, limiting false change-point
 * triggers on heavy-tailed returns while still flagging structural breaks.
 */
export const DEFAULT_CUSUM_H = 5.0;

/**
 * Linear decay horizon (in bars) over which a detected CUSUM change-point
 * contributes to the descriptive regime intensity score.
 */
export const DEFAULT_CUSUM_DECAY_BARS = 10;

/**
 * Deterministic weights summing to 1.0 across volatility z-score extremity,
 * absolute OLS trend R^2, and recent CUSUM change-point proximity.
 */
export const DEFAULT_SCORE_WEIGHTS = {
  volatility: 0.45,
  trend: 0.35,
  cusum: 0.2,
} as const;

export interface LogReturnEntry {
  barIndex: number;
  time: number;
  value: number;
}

export interface LogReturnsResult {
  byBar: ReadonlyArray<number | null>;
  entries: ReadonlyArray<LogReturnEntry>;
  skippedCount: number;
  skippedTimes: ReadonlyArray<number>;
  gapCount: number;
  gapTimes: ReadonlyArray<number>;
  gapByBar: ReadonlyArray<boolean>;
  nonPositiveByBar: ReadonlyArray<boolean>;
  nonPositiveCount: number;
  medianIntervalSec: number | null;
}

export interface VolatilityZOptions {
  volWindow?: number;
  volLookback?: number;
}

export interface CusumParams {
  volWindow?: number;
  k?: number;
  h?: number;
}

export interface CusumChangePoint {
  time: number;
  barIndex: number;
  direction: 'up' | 'down';
  magnitude: number;
}

export interface RegimeScoreWeights {
  volatility: number;
  trend: number;
  cusum: number;
}

export interface RegimeScoreInput {
  volZ: number | null;
  trend: number | null;
  barsSinceCusum?: number | null;
  cusumDecayBars?: number;
}

export interface RegimeOptions {
  volWindow?: number;
  volLookback?: number;
  trendWindow?: number;
  cusumVolWindow?: number;
  cusumK?: number;
  cusumH?: number;
  cusumDecayBars?: number;
  weights?: RegimeScoreWeights;
}

export interface ResolvedRegimeOptions {
  volWindow: number;
  volLookback: number;
  trendWindow: number;
  cusumVolWindow: number;
  cusumK: number;
  cusumH: number;
  cusumDecayBars: number;
  weights: RegimeScoreWeights;
}

export interface RegimeSeriesPoint {
  time: number;
  volZ: number | null;
  trend: number | null;
  score: number | null;
}

export interface RegimeMeta {
  candleCount: number;
  skippedNonPositiveCloses: number;
  skippedGaps: number;
  gapTimes: ReadonlyArray<number>;
  skippedTimes: ReadonlyArray<number>;
  requiredBarsForVolZ: number;
  requiredBarsForTrend: number;
  requiredBarsForCusum: number;
  options: ResolvedRegimeOptions;
}

export interface RegimeSeriesResult {
  series: ReadonlyArray<RegimeSeriesPoint>;
  markers: ReadonlyArray<CusumChangePoint>;
  latest: {
    time: number | null;
    volZ: number | null;
    trend: number | null;
    score: number | null;
    barsSinceCusum: number | null;
    cusumCount: number;
  };
  meta: RegimeMeta;
}

const ZERO_EPSILON = 1e-12;

function isValidPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Sample standard deviation (ddof = 1). Returns null if length < 2.
 */
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

function sampleMean(values: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
  }
  return sum / values.length;
}

export function resolveRegimeOptions(options?: RegimeOptions): ResolvedRegimeOptions {
  return {
    volWindow: Math.max(2, Math.floor(options?.volWindow ?? DEFAULT_VOL_WINDOW)),
    volLookback: Math.max(2, Math.floor(options?.volLookback ?? DEFAULT_VOL_LOOKBACK)),
    trendWindow: Math.max(2, Math.floor(options?.trendWindow ?? DEFAULT_TREND_WINDOW)),
    cusumVolWindow: Math.max(2, Math.floor(options?.cusumVolWindow ?? DEFAULT_CUSUM_VOL_WINDOW)),
    cusumK: options?.cusumK ?? DEFAULT_CUSUM_K,
    cusumH: options?.cusumH ?? DEFAULT_CUSUM_H,
    cusumDecayBars: Math.max(1, Math.floor(options?.cusumDecayBars ?? DEFAULT_CUSUM_DECAY_BARS)),
    weights: options?.weights ?? DEFAULT_SCORE_WEIGHTS,
  };
}

function computeMedianSorted(sortedAsc: readonly number[]): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

function insertSorted(sortedAsc: number[], value: number): void {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAsc[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  sortedAsc.splice(lo, 0, value);
}

/**
 * Compute per-bar log returns: r[i] = ln(close[i] / close[i - 1]).
 *
 * Any transition involving a non-positive/non-finite close OR a bar-time gap
 * where dt > 1.5 * causalMedianPositiveInterval (overnight/weekend/missing candle)
 * is skipped (byBar[i] = null) and recorded in skippedCount / skippedTimes so it
 * never feeds into CUSUM or rolling volatility. Gap threshold uses strictly
 * preceding positive intervals (bars <= i - 1) so there is zero lookahead.
 */
export function logReturns(candles: readonly CandlePoint[]): LogReturnsResult {
  const n = candles.length;
  const byBar = new Array<number | null>(n).fill(null);
  const gapByBar = new Array<boolean>(n).fill(false);
  const nonPositiveByBar = new Array<boolean>(n).fill(false);
  const entries: LogReturnEntry[] = [];
  const skippedTimes: number[] = [];
  const gapTimes: number[] = [];
  const sortedPriorDiffs: number[] = [];
  let skippedCount = 0;
  let gapCount = 0;
  let nonPositiveCount = 0;

  if (n === 0) {
    return {
      byBar,
      entries,
      skippedCount,
      skippedTimes,
      gapCount,
      gapTimes,
      gapByBar,
      nonPositiveByBar,
      nonPositiveCount,
      medianIntervalSec: null,
    };
  }

  if (!isValidPositive(candles[0].close)) {
    nonPositiveByBar[0] = true;
    nonPositiveCount += 1;
    skippedCount += 1;
    skippedTimes.push(candles[0].time);
  }

  for (let i = 1; i < n; i += 1) {
    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;
    const dt = candles[i].time - candles[i - 1].time;
    const priorMedianSec = computeMedianSorted(sortedPriorDiffs);
    const isGap =
      Number.isFinite(dt) &&
      dt > 0 &&
      priorMedianSec !== null &&
      priorMedianSec > 0 &&
      dt > 1.5 * priorMedianSec;

    if (Number.isFinite(dt) && dt > 0) {
      insertSorted(sortedPriorDiffs, dt);
    }

    if (!isValidPositive(currClose)) {
      nonPositiveByBar[i] = true;
      nonPositiveCount += 1;
      skippedCount += 1;
      skippedTimes.push(candles[i].time);
      continue;
    }

    if (!isValidPositive(prevClose)) {
      nonPositiveByBar[i] = true;
      nonPositiveCount += 1;
      skippedCount += 1;
      skippedTimes.push(candles[i].time);
      continue;
    }

    if (isGap) {
      gapByBar[i] = true;
      gapCount += 1;
      skippedCount += 1;
      gapTimes.push(candles[i].time);
      skippedTimes.push(candles[i].time);
      continue;
    }

    const r = Math.log(currClose / prevClose);
    if (!Number.isFinite(r)) {
      nonPositiveByBar[i] = true;
      nonPositiveCount += 1;
      skippedCount += 1;
      skippedTimes.push(candles[i].time);
      continue;
    }

    byBar[i] = r;
    entries.push({ barIndex: i, time: candles[i].time, value: r });
  }

  return {
    byBar,
    entries,
    skippedCount,
    skippedTimes,
    gapCount,
    gapTimes,
    gapByBar,
    nonPositiveByBar,
    nonPositiveCount,
    medianIntervalSec: computeMedianSorted(sortedPriorDiffs),
  };
}

function computeRollingVolSeries(
  logReturnByBar: ReadonlyArray<number | null>,
  volWindow: number,
  nonPositiveByBar?: ReadonlyArray<boolean>,
): Array<number | null> {
  const n = logReturnByBar.length;
  const vols = new Array<number | null>(n).fill(null);
  if (volWindow < 2) return vols;

  const minValidReturnsInWindow = Math.max(2, Math.ceil(volWindow / 2));

  for (let t = volWindow; t < n; t += 1) {
    const slice: number[] = [];
    let hasNonPositive = false;
    for (let j = t - volWindow + 1; j <= t; j += 1) {
      if (nonPositiveByBar && nonPositiveByBar[j]) {
        hasNonPositive = true;
        break;
      }
      const val = logReturnByBar[j];
      if (val !== null) {
        slice.push(val);
      }
    }
    if (!hasNonPositive && slice.length >= minValidReturnsInWindow) {
      vols[t] = sampleStdDev(slice);
    }
  }

  return vols;
}

function computeRollingVolZAtBar(
  rollingVols: ReadonlyArray<number | null>,
  barIndex: number,
  volLookback: number,
): number | null {
  if (volLookback < 2 || barIndex < volLookback - 1) return null;
  const windowVols: number[] = [];
  for (let j = barIndex - volLookback + 1; j <= barIndex; j += 1) {
    const v = rollingVols[j];
    if (v === null) return null;
    windowVols.push(v);
  }
  const latestVol = windowVols[windowVols.length - 1];
  const meanVol = sampleMean(windowVols);
  const stdOfVol = sampleStdDev(windowVols);
  if (stdOfVol === null) return null;
  if (stdOfVol <= ZERO_EPSILON) return 0;
  return (latestVol - meanVol) / stdOfVol;
}

/**
 * Rolling Z-Score of Volatility.
 *
 * Formula:
 * 1. Compute log returns r_t = ln(close[t] / close[t-1]).
 * 2. At each bar t, compute rolling sample standard deviation sigma_t over
 *    the trailing W = volWindow log returns (ddof = 1).
 * 3. Over the trailing L = volLookback rolling standard deviations
 *    {sigma_{t-L+1}, ..., sigma_t}, compute sample mean mu_sigma and sample
 *    standard deviation s_sigma (ddof = 1).
 * 4. volZ_t = (sigma_t - mu_sigma) / s_sigma (or 0 when s_sigma <= 1e-12).
 *
 * Requires at least volWindow + volLookback valid contiguous candles.
 * Returns null if fewer bars exist or any bar in the required window was skipped.
 */
export function rollingZScoreOfVolatility(
  candles: readonly CandlePoint[],
  windowOrOptions: number | VolatilityZOptions = DEFAULT_VOL_WINDOW,
): number | null {
  const volWindow =
    typeof windowOrOptions === 'number'
      ? Math.max(2, Math.floor(windowOrOptions))
      : Math.max(2, Math.floor(windowOrOptions.volWindow ?? DEFAULT_VOL_WINDOW));
  const volLookback =
    typeof windowOrOptions === 'number'
      ? DEFAULT_VOL_LOOKBACK
      : Math.max(2, Math.floor(windowOrOptions.volLookback ?? DEFAULT_VOL_LOOKBACK));

  if (candles.length < volWindow + volLookback) {
    return null;
  }

  const lr = logReturns(candles);
  const rollingVols = computeRollingVolSeries(lr.byBar, volWindow, lr.nonPositiveByBar);
  return computeRollingVolZAtBar(rollingVols, candles.length - 1, volLookback);
}

/**
 * Signed Trend Strength over a trailing window of W bars.
 *
 * Formula:
 * Fits OLS linear regression close[i] ~ alpha + beta * i for i = 0..W-1:
 *   trend = sign(beta) * R^2
 * where R^2 = (Cov(i, close)^2) / (Var(i) * Var(close)) in [0, 1].
 * Range is [-1, +1]: +1 is a noiseless linear uptrend, -1 is a noiseless
 * linear downtrend, and 0 represents a flat series (Var(close) <= 1e-12 or
 * zero slope).
 *
 * Returns null if candles.length < window or any close in the window is non-finite.
 */
export function trendStrength(
  candles: readonly CandlePoint[],
  window: number = DEFAULT_TREND_WINDOW,
): number | null {
  const w = Math.max(2, Math.floor(window));
  if (candles.length < w) {
    return null;
  }

  const start = candles.length - w;
  const meanX = (w - 1) / 2;
  let sumY = 0;

  for (let i = 0; i < w; i += 1) {
    const close = candles[start + i].close;
    if (!Number.isFinite(close)) return null;
    sumY += close;
  }

  const meanY = sumY / w;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (let i = 0; i < w; i += 1) {
    const dx = i - meanX;
    const dy = candles[start + i].close - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  if (sxx <= ZERO_EPSILON || syy <= ZERO_EPSILON) {
    return 0;
  }

  if (Math.abs(sxy) <= ZERO_EPSILON) {
    return 0;
  }

  const rSquared = Math.min(1, Math.max(0, (sxy * sxy) / (sxx * syy)));
  return sxy > 0 ? rSquared : -rSquared;
}

/**
 * Two-sided CUSUM change-point detector on volatility-standardized log returns.
 *
 * Formula:
 * 1. At bar t, standardize return r_t using the *lagged* rolling sample stdev
 *    sigma_{t-1} of the preceding volWindow log returns {r_{t-W}, ..., r_{t-1}}:
 *      z_t = r_t / sigma_{t-1}
 *    (Lagging sigma prevents a large single-bar shock from masking itself inside
 *    its own volatility denominator; bars where sigma_{t-1} <= 1e-12 are skipped
 *    so constant price series never produce false triggers.)
 * 2. Update two-sided accumulators:
 *      S_t^+ = max(0, S_{t-1}^+ + z_t - k)
 *      S_t^- = max(0, S_{t-1}^- - z_t - k)
 *    where k = reference slack (default 0.5 sigma).
 * 3. When S_t^+ >= h or S_t^- >= h (default h = 5.0), record a change-point at
 *    candles[t].time and reset both accumulators (S^+ = 0, S^- = 0).
 */
export function cusumChangePoints(
  candles: readonly CandlePoint[],
  params?: CusumParams,
): CusumChangePoint[] {
  const volWindow = Math.max(2, Math.floor(params?.volWindow ?? DEFAULT_CUSUM_VOL_WINDOW));
  const k = params?.k ?? DEFAULT_CUSUM_K;
  const h = params?.h ?? DEFAULT_CUSUM_H;

  if (candles.length < volWindow + 2) {
    return [];
  }

  const lr = logReturns(candles);
  const rollingVols = computeRollingVolSeries(lr.byBar, volWindow, lr.nonPositiveByBar);
  const markers: CusumChangePoint[] = [];

  let sPos = 0;
  let sNeg = 0;

  for (let t = volWindow + 1; t < candles.length; t += 1) {
    const r = lr.byBar[t];
    const priorVol = rollingVols[t - 1];

    if (r === null || priorVol === null || priorVol <= ZERO_EPSILON) {
      continue;
    }

    const z = r / priorVol;
    sPos = Math.max(0, sPos + z - k);
    sNeg = Math.max(0, sNeg - z - k);

    if (sPos >= h && sPos >= sNeg) {
      markers.push({
        time: candles[t].time,
        barIndex: t,
        direction: 'up',
        magnitude: sPos,
      });
      sPos = 0;
      sNeg = 0;
    } else if (sNeg >= h) {
      markers.push({
        time: candles[t].time,
        barIndex: t,
        direction: 'down',
        magnitude: sNeg,
      });
      sPos = 0;
      sNeg = 0;
    }
  }

  return markers;
}

/**
 * Composite 0–100 descriptive Regime Intensity Score.
 *
 * Formula:
 * - Volatility component: V = clamp01((volZ + 1) / 4)
 *   (Maps volZ from [-1 sigma .. +3 sigma] onto [0 .. 1].)
 * - Trend component: T = clamp01(|trend|)
 *   (Uses R^2 magnitude in [0 .. 1] regardless of up/down sign.)
 * - CUSUM recency component: C = clamp01(1 - barsSinceCusum / decayBars) if
 *   a change-point occurred within decayBars, else 0.
 * - Score = clamp(100 * (w_v * V + w_t * T + w_c * C), 0, 100)
 *   Default weights: w_v = 0.45, w_t = 0.35, w_c = 0.20.
 *
 * Returns null if volZ or trend is null/non-finite.
 */
export function regimeScore(
  inputs: RegimeScoreInput,
  weights: RegimeScoreWeights = DEFAULT_SCORE_WEIGHTS,
): number | null {
  const { volZ, trend, barsSinceCusum = null, cusumDecayBars = DEFAULT_CUSUM_DECAY_BARS } = inputs;
  if (volZ === null || trend === null || !Number.isFinite(volZ) || !Number.isFinite(trend)) {
    return null;
  }

  const volComponent = clamp01((volZ + 1) / 4);
  const trendComponent = clamp01(Math.abs(trend));
  const decay = Math.max(1, cusumDecayBars);
  const cusumComponent =
    barsSinceCusum !== null && barsSinceCusum !== undefined && Number.isFinite(barsSinceCusum) && barsSinceCusum >= 0
      ? clamp01(1 - barsSinceCusum / decay)
      : 0;

  const raw =
    100 *
    (weights.volatility * volComponent +
      weights.trend * trendComponent +
      weights.cusum * cusumComponent);

  return Math.min(100, Math.max(0, raw));
}

/**
 * Compute full per-bar regime series, CUSUM change-point markers, latest summary,
 * and window/missing-data metadata for a loaded candle array.
 */
export function computeRegimeSeries(
  candles: readonly CandlePoint[],
  rawOptions?: RegimeOptions,
): RegimeSeriesResult {
  const options = resolveRegimeOptions(rawOptions);
  const lr = logReturns(candles);
  const rollingVols = computeRollingVolSeries(lr.byBar, options.volWindow, lr.nonPositiveByBar);
  const markers = cusumChangePoints(candles, {
    volWindow: options.cusumVolWindow,
    k: options.cusumK,
    h: options.cusumH,
  });

  const markerBarSet = new Set<number>(markers.map((m) => m.barIndex));
  const series: RegimeSeriesPoint[] = new Array<RegimeSeriesPoint>(candles.length);

  let lastMarkerBar: number | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    if (markerBarSet.has(i)) {
      lastMarkerBar = i;
    }

    const volZ = computeRollingVolZAtBar(rollingVols, i, options.volLookback);
    const trend =
      i + 1 >= options.trendWindow
        ? trendStrength(candles.slice(i + 1 - options.trendWindow, i + 1), options.trendWindow)
        : null;
    const barsSinceCusum = lastMarkerBar !== null ? i - lastMarkerBar : null;
    const score = regimeScore(
      {
        volZ,
        trend,
        barsSinceCusum,
        cusumDecayBars: options.cusumDecayBars,
      },
      options.weights,
    );

    series[i] = {
      time: candles[i].time,
      volZ,
      trend,
      score,
    };
  }

  const latestPoint = series.length > 0 ? series[series.length - 1] : null;
  const latestBarsSinceCusum =
    lastMarkerBar !== null && series.length > 0 ? series.length - 1 - lastMarkerBar : null;

  return {
    series,
    markers,
    latest: {
      time: latestPoint?.time ?? null,
      volZ: latestPoint?.volZ ?? null,
      trend: latestPoint?.trend ?? null,
      score: latestPoint?.score ?? null,
      barsSinceCusum: latestBarsSinceCusum,
      cusumCount: markers.length,
    },
    meta: {
      candleCount: candles.length,
      skippedNonPositiveCloses: lr.nonPositiveCount,
      skippedGaps: lr.gapCount,
      gapTimes: lr.gapTimes,
      skippedTimes: lr.skippedTimes,
      requiredBarsForVolZ: options.volWindow + options.volLookback,
      requiredBarsForTrend: options.trendWindow,
      requiredBarsForCusum: options.cusumVolWindow + 2,
      options,
    },
  };
}
