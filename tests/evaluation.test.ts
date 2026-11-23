import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAlertEpisodes,
  computeCausalGuardrailsSeries,
  computeCircularShiftBaseline,
  detectSpikeEvents,
  evaluateDetector,
  matchEventsToAlerts,
  resolveEvaluationOptions,
  wilsonInterval95,
  type SpikeEvent,
} from '../src/engine/evaluation';
import type { CandlePoint } from '../src/engine/regime';

function makeCandlesFromCloses(closes: readonly number[], intervalSec = 900): CandlePoint[] {
  return closes.map((close, idx) => ({
    time: 1_700_000_000 + idx * intervalSec,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
}

test('detectSpikeEvents identifies a single obvious step and merges overlapping starts within H bars', () => {
  // Hand-written closes with H = 2, K = 2.5, spikeMinSamples = 4:
  // Causal 2-bar returns r_2[t] = close[t]/close[t-2] - 1:
  //   t=2: 101/100 - 1 = +0.01
  //   t=3: 100/100 - 1 = 0
  //   t=4: 99/101 - 1  = -0.01980198
  //   t=5: 100/100 - 1 = 0
  //   t=6: 101/99 - 1  = +0.02020202
  //   t=7: 100/100 - 1 = 0
  //   t=8: 99/101 - 1  = -0.01980198
  // At i=7: forward 2-bar return = 120/100 - 1 = +0.20 (20%).
  // Trailing r_2[2..7] has 6 samples with sample stdev ~ 0.01442 -> 2.5 * sigma ~ 0.03605 < 0.20 => EVENT at bar 7.
  // At i=8: forward return 120/99 - 1 = +0.2121 would also exceed threshold, but 8 - 7 = 1 < H (2), so merged/skipped.
  const closes = [100, 100, 101, 100, 99, 100, 101, 100, 99, 120, 120, 120];
  const candles = makeCandlesFromCloses(closes);
  const events = detectSpikeEvents(candles, {
    horizonBars: 2,
    sigmaMultiplier: 2.5,
    spikeVolLookbackBars: 10,
    spikeMinSamples: 4,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].startBar, 7);
  assert.equal(events[0].endBar, 9);
  assert.ok(Math.abs(events[0].forwardReturn - 0.2) < 1e-12);
});

test('matchEventsToAlerts computes lead time in bars and minutes using earliest alert in [e - L, e]', () => {
  // 12 bars at 15-minute spacing; event starts at bar 7; lookback L = 5 => window [2, 7].
  // Alerts fire at bars 3 and 4; bar 0 is outside the lookback window.
  // Earliest alert inside [2, 7] is bar 3 => lead time = 7 - 3 = 4 bars = 60 minutes.
  const alerts = [
    true, false, false, true, true, false, false, false, false, false, false, false,
  ];
  const times = alerts.map((_, idx) => 1_700_000_000 + idx * 900);
  const events: SpikeEvent[] = [
    {
      startBar: 7,
      endBar: 9,
      startTime: times[7],
      endTime: times[9],
      forwardReturn: 0.15,
      absForwardReturn: 0.15,
      trailingSigmaH: 0.02,
      thresholdReturn: 0.05,
    },
  ];

  const matches = matchEventsToAlerts(alerts, times, events, 5, 15);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].hit, true);
  assert.equal(matches[0].earliestAlertBar, 3);
  assert.equal(matches[0].leadTimeBars, 4);
  assert.equal(matches[0].leadTimeMinutes, 60);
});

test('buildAlertEpisodes merges consecutive alert bars and counts false alarms accurately', () => {
  // Alerts at [1, 2, 3] (episode 0: start=1, end=3) and [6, 7] (episode 1: start=6, end=7).
  // Horizon H = 3; single event starts at bar 8.
  // Episode 0 checks [1, 4]: event 8 not in [1, 4] => false alarm.
  // Episode 1 checks [6, 9]: event 8 in [6, 9] => true episode.
  const alerts = [
    false, true, true, true, false, false, true, true, false, false, false, false,
  ];
  const times = alerts.map((_, idx) => 1_700_000_000 + idx * 900);
  const events: SpikeEvent[] = [
    {
      startBar: 8,
      endBar: 11,
      startTime: times[8],
      endTime: times[11],
      forwardReturn: -0.1,
      absForwardReturn: 0.1,
      trailingSigmaH: 0.02,
      thresholdReturn: 0.05,
    },
  ];

  const episodes = buildAlertEpisodes(alerts, times, events, 3);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].startBar, 1);
  assert.equal(episodes[0].endBar, 3);
  assert.equal(episodes[0].lengthBars, 3);
  assert.equal(episodes[0].isTrueEpisode, false);

  assert.equal(episodes[1].startBar, 6);
  assert.equal(episodes[1].endBar, 7);
  assert.equal(episodes[1].lengthBars, 2);
  assert.equal(episodes[1].isTrueEpisode, true);

  const falseAlarms = episodes.filter((ep) => !ep.isTrueEpisode).length;
  assert.equal(falseAlarms, 1);
});

test('a missed event reduces recall while true hits are counted', () => {
  // 2 events: startBar = 5 and startBar = 14. Lookback L = 3.
  // Single alert at bar 3 hits event 0 (window [2, 5]) and misses event 1 (window [11, 14]).
  // Expected: hits = 1, missedEvents = 1, recall = 1 / 2 = 0.5.
  const alerts = new Array<boolean>(18).fill(false);
  alerts[3] = true;
  const times = alerts.map((_, idx) => 1_700_000_000 + idx * 900);
  const events: SpikeEvent[] = [
    {
      startBar: 5,
      endBar: 7,
      startTime: times[5],
      endTime: times[7],
      forwardReturn: 0.1,
      absForwardReturn: 0.1,
      trailingSigmaH: 0.02,
      thresholdReturn: 0.05,
    },
    {
      startBar: 14,
      endBar: 16,
      startTime: times[14],
      endTime: times[16],
      forwardReturn: -0.12,
      absForwardReturn: 0.12,
      trailingSigmaH: 0.02,
      thresholdReturn: 0.05,
    },
  ];

  const matches = matchEventsToAlerts(alerts, times, events, 3, 15);
  const hits = matches.filter((m) => m.hit).length;
  const missed = matches.filter((m) => !m.hit).length;
  const recall = hits / events.length;

  assert.equal(hits, 1);
  assert.equal(missed, 1);
  assert.equal(recall, 0.5);
});

test('computeCircularShiftBaseline computes deterministic mean and range across fixed shifts', () => {
  // Series length n = 10; single alert at bar 0; single event at startBar = 4.
  // H = 2, L = 2; fixed percents [20, 40, 60] => shifts [2, 4, 6].
  // - shift 2: alert at bar 2 => inside [2, 4] (hit, recall=1) & event 4 inside [2, 4] (true episode, prec=1)
  // - shift 4: alert at bar 4 => inside [2, 4] (hit, recall=1) & event 4 inside [4, 6] (true episode, prec=1)
  // - shift 6: alert at bar 6 => outside [2, 4] (miss, recall=0) & event 4 outside [6, 8] (false alarm, prec=0)
  // Mean recall = 2/3, min = 0, max = 1; Mean precision = 2/3, min = 0, max = 1.
  const alerts = [true, false, false, false, false, false, false, false, false, false];
  const times = alerts.map((_, idx) => 1_700_000_000 + idx * 900);
  const events: SpikeEvent[] = [
    {
      startBar: 4,
      endBar: 6,
      startTime: times[4],
      endTime: times[6],
      forwardReturn: 0.1,
      absForwardReturn: 0.1,
      trailingSigmaH: 0.02,
      thresholdReturn: 0.05,
    },
  ];
  const candles = makeCandlesFromCloses(alerts.map(() => 100));
  const resolved = resolveEvaluationOptions(candles, {
    horizonBars: 2,
    leadLookbackBars: 2,
    circularShiftPercents: [20, 40, 60],
    barIntervalMinutes: 15,
  });

  const baseline = computeCircularShiftBaseline(alerts, times, events, 0, resolved);
  assert.ok(baseline !== null);
  assert.equal(baseline.shiftCount, 3);
  assert.deepEqual(baseline.offsetsBars, [2, 4, 6]);
  assert.ok(baseline.recall !== null);
  assert.ok(Math.abs(baseline.recall.mean - 2 / 3) < 1e-12);
  assert.equal(baseline.recall.min, 0);
  assert.equal(baseline.recall.max, 1);
  assert.ok(baseline.precision !== null);
  assert.ok(Math.abs(baseline.precision.mean - 2 / 3) < 1e-12);
  assert.equal(baseline.precision.min, 0);
  assert.equal(baseline.precision.max, 1);
});

test('wilsonInterval95 for 5 of 10 matches 0.237 to 0.763', () => {
  // k = 5, n = 10, p = 0.5, z = 1.9599639845:
  // center = (0.5 + z^2 / 20) / (1 + z^2 / 10) = 0.5
  // halfWidth = z * sqrt((0.25 + z^2 / 40) / 10) / (1 + z^2 / 10) ≈ 0.263407
  // lower ≈ 0.23659 (0.237), upper ≈ 0.76341 (0.763)
  const ci = wilsonInterval95(5, 10);
  assert.ok(ci !== null);
  assert.equal(ci.point, 0.5);
  assert.ok(Math.abs(ci.lower - 0.2366) < 0.001);
  assert.ok(Math.abs(ci.upper - 0.7634) < 0.001);
  assert.equal(ci.lower.toFixed(3), '0.237');
  assert.equal(ci.upper.toFixed(3), '0.763');
});

test('no-lookahead: causal guardrail output at bar i on candles[0..i] equals full-array output at bar i', () => {
  // Deterministic 110-bar series with quiet oscillation followed by a volatility shock and trend.
  const closes: number[] = [
    100, 100.3, 99.8, 100.1, 99.9, 100.2, 99.7, 100.4, 100.0, 99.8,
    100.2, 100.5, 100.1, 99.9, 100.3, 100.0, 99.8, 100.2, 100.4, 100.1,
    100.3, 99.9, 100.2, 100.4, 100.0, 99.8, 100.1, 100.3, 100.2, 99.9,
    100.1, 100.4, 100.2, 99.8, 100.0, 100.3, 100.1, 99.9, 100.2, 100.0,
    100.4, 100.1, 99.7, 100.2, 100.3, 100.0, 99.8, 100.1, 100.4, 100.2,
    99.9, 100.1, 100.3, 100.0, 99.8, 100.2, 100.5, 100.1, 99.9, 100.2,
    100.0, 100.3, 100.1, 99.8, 100.2, 100.4, 100.1, 99.9, 100.3, 100.0,
    100.2, 100.4, 100.1, 99.8, 100.2, 100.3, 100.0, 99.9, 100.1, 100.4,
    100.2, 100.5, 101.2, 102.4, 104.1, 106.5, 109.0, 112.2, 110.5, 114.0,
    117.5, 115.0, 119.2, 122.0, 118.5, 121.0, 124.5, 123.0, 126.2, 129.0,
    127.4, 125.8, 126.5, 128.0, 127.1, 129.4, 131.0, 130.2, 132.5, 134.0,
  ];
  const candles = makeCandlesFromCloses(closes);
  const fullSeries = computeCausalGuardrailsSeries(candles);

  // Verify warmup, boundary, shock, and post-shock bars
  const checkIndices = [0, 19, 45, 79, 80, 84, 88, 95, 109];
  for (const idx of checkIndices) {
    const truncatedSeries = computeCausalGuardrailsSeries(candles.slice(0, idx + 1));
    const truncatedBar = truncatedSeries[idx];
    const fullBar = fullSeries[idx];

    assert.equal(truncatedBar.score, fullBar.score);
    assert.equal(truncatedBar.volZ, fullBar.volZ);
    assert.equal(truncatedBar.trend, fullBar.trend);
    assert.equal(truncatedBar.changePointsInWindow, fullBar.changePointsInWindow);
    assert.equal(truncatedBar.lastChangePointAgeBars, fullBar.lastChangePointAgeBars);
    assert.equal(truncatedBar.decision, fullBar.decision);
    assert.deepEqual(truncatedBar.firedRules, fullBar.firedRules);
    assert.deepEqual(truncatedBar.reasons, fullBar.reasons);
    assert.equal(truncatedBar.isAlert, fullBar.isAlert);
    assert.equal(truncatedBar.isPauseAlert, fullBar.isPauseAlert);
  }
});

test('evaluateDetector returns null metrics and insufficientSample flag when events < 20 or episodes < 20', () => {
  // Only 20 bars => 0 events (< 20) and 0 alert episodes (< 20).
  const closes = [
    100, 101, 100, 101, 100, 101, 100, 101, 100, 101,
    100, 101, 100, 101, 100, 101, 100, 101, 100, 101,
  ];
  const candles = makeCandlesFromCloses(closes);
  const report = evaluateDetector(candles);

  assert.equal(report.whole.allAlerts.insufficientSample, true);
  assert.ok(report.whole.allAlerts.insufficientSampleReason?.includes('Insufficient sample'));
  assert.equal(report.whole.allAlerts.recall, null);
  assert.equal(report.whole.allAlerts.precision, null);
  assert.equal(report.whole.allAlerts.falseAlarmsPer100Bars, null);
  assert.equal(report.whole.allAlerts.wilsonRecall95, null);
  assert.equal(report.whole.allAlerts.wilsonPrecision95, null);
  assert.equal(report.whole.allAlerts.leadTimeBars, null);
  assert.equal(report.whole.allAlerts.leadTimeMinutes, null);
  assert.equal(report.whole.allAlerts.baseline, null);

  assert.equal(report.whole.pauseOnly.insufficientSample, true);
  assert.equal(report.whole.pauseOnly.recall, null);
  assert.equal(report.firstHalf.allAlerts.insufficientSample, true);
  assert.equal(report.secondHalf.allAlerts.insufficientSample, true);
});
