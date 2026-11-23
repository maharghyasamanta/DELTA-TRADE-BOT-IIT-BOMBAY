import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeRegimeSeries,
  cusumChangePoints,
  logReturns,
  regimeScore,
  rollingZScoreOfVolatility,
  trendStrength,
  type CandlePoint,
} from '../src/engine/regime';

function makeCandles(closes: readonly number[], startTime = 1_700_000_000): CandlePoint[] {
  return closes.map((close, idx) => ({
    time: startTime + idx * 900,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
}

test('logReturns computes exact ln(close[i]/close[i-1]) on 4 known closes', () => {
  // Closes: [100, 110, 99, 99]
  // r[1] = ln(110 / 100) = ln(1.1) ~= 0.09531017980432493
  // r[2] = ln(99 / 110) = ln(0.9) ~= -0.10536051565782628
  // r[3] = ln(99 / 99) = ln(1.0) = 0
  const candles = makeCandles([100, 110, 99, 99]);
  const res = logReturns(candles);

  assert.equal(res.skippedCount, 0);
  assert.equal(res.entries.length, 3);
  assert.equal(res.byBar[0], null);
  assert.ok(Math.abs((res.byBar[1] ?? NaN) - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs((res.byBar[2] ?? NaN) - Math.log(0.9)) < 1e-12);
  assert.equal(res.byBar[3], 0);
});

test('logReturns skips and reports non-positive closes without producing NaN', () => {
  // Closes: [100, 0, 105, -5, 110]
  // Transitions (100->0), (0->105), (105->-5), (-5->110) all involve non-positive closes -> skipped
  const candles = makeCandles([100, 0, 105, -5, 110]);
  const res = logReturns(candles);

  assert.equal(res.skippedCount, 4);
  assert.equal(res.entries.length, 0);
  for (const val of res.byBar) {
    assert.equal(val, null);
  }
});

test('trendStrength returns +1 on perfectly linear uptrend, -1 on downtrend, and 0 on flat series', () => {
  // Linear uptrend: [10, 12, 14, 16, 18] -> beta = +2, R^2 = 1 -> +1
  const up = makeCandles([10, 12, 14, 16, 18]);
  assert.equal(trendStrength(up, 5), 1);

  // Linear downtrend: [50, 45, 40, 35, 30] -> beta = -5, R^2 = 1 -> -1
  const down = makeCandles([50, 45, 40, 35, 30]);
  assert.equal(trendStrength(down, 5), -1);

  // Perfectly flat series: [100, 100, 100, 100, 100] -> Var(close) = 0 -> 0
  const flat = makeCandles([100, 100, 100, 100, 100]);
  assert.equal(trendStrength(flat, 5), 0);

  // Insufficient bars (4 < window 5) -> null
  assert.equal(trendStrength(makeCandles([10, 11, 12, 13]), 5), null);
});

test('rollingZScoreOfVolatility returns null when fewer bars than required and exact z-score when sufficient', () => {
  // Need volWindow + volLookback = 3 + 3 = 6 bars. 5 bars must return null.
  const tooShort = makeCandles([100, 102, 101, 103, 102]);
  assert.equal(
    rollingZScoreOfVolatility(tooShort, { volWindow: 3, volLookback: 3 }),
    null,
  );

  // Hand-computed exact check with 6 bars, volWindow = 3, volLookback = 3:
  // Use geometric steps so log returns are exact multiples:
  // c = [1, e^1, e^2, e^4, e^4, e^10] -> log returns = [1, 1, 2, 0, 6]
  // Window 1 [1, 1, 2]: mean = 4/3, sq = [( -1/3)^2, (-1/3)^2, (2/3)^2] = 6/9 = 2/3, ddof=1 var = 1/3 -> sd1 = sqrt(1/3)
  // Window 2 [1, 2, 0]: mean = 1, sq = [0, 1, 1] = 2, ddof=1 var = 1 -> sd2 = 1
  // Window 3 [2, 0, 6]: mean = 8/3, sq = [(-2/3)^2, (-8/3)^2, (10/3)^2] = (4+64+100)/9 = 168/9 = 56/3, ddof=1 var = 28/3 -> sd3 = sqrt(28/3)
  const closes = [1, Math.exp(1), Math.exp(2), Math.exp(4), Math.exp(4), Math.exp(10)];
  const sd1 = Math.sqrt(1 / 3);
  const sd2 = 1;
  const sd3 = Math.sqrt(28 / 3);
  const meanSd = (sd1 + sd2 + sd3) / 3;
  const stdOfSd = Math.sqrt(
    ((sd1 - meanSd) ** 2 + (sd2 - meanSd) ** 2 + (sd3 - meanSd) ** 2) / 2,
  );
  const expectedZ = (sd3 - meanSd) / stdOfSd;

  const actualZ = rollingZScoreOfVolatility(makeCandles(closes), {
    volWindow: 3,
    volLookback: 3,
  });
  assert.ok(actualZ !== null);
  assert.ok(Math.abs(actualZ - expectedZ) < 1e-12);
});

test('cusumChangePoints fires on a hand-built step change and does not fire on a constant series', () => {
  // Constant series of 20 bars: all log returns = 0, rolling vol = 0 -> zero markers
  const constant = makeCandles(new Array<number>(20).fill(100));
  assert.deepEqual(
    cusumChangePoints(constant, { volWindow: 4, k: 0.5, h: 5 }),
    [],
  );

  // Small alternating baseline returns over 6 bars:
  // [100, 101, 100, 101, 100, 101] -> prior 4-bar log returns ~ +/-0.00995, priorVol ~ 0.01149
  // Then bar 6 jumps from 101 to 112 (r = ln(112/101) ~ 0.10339 -> z ~ 9.0)
  // S+ = max(0, 0 + 9.0 - 0.5) ~ 8.5 >= h (5.0) -> fires upward change-point at barIndex 6!
  // Followed by quiet bars [112.1, 112.0, 112.1] where S+ reset to 0 stays below h.
  const startTime = 1_700_000_000;
  const stepSeries = makeCandles(
    [100, 101, 100, 101, 100, 101, 112, 112.05, 112.0, 112.05],
    startTime,
  );
  const markers = cusumChangePoints(stepSeries, { volWindow: 4, k: 0.5, h: 5 });

  assert.equal(markers.length, 1);
  assert.equal(markers[0].barIndex, 6);
  assert.equal(markers[0].time, startTime + 6 * 900);
  assert.equal(markers[0].direction, 'up');
  assert.ok(markers[0].magnitude >= 5);
});

test('regimeScore clamps to 0 and 100 and returns null when any required input is null', () => {
  // Null inputs must return null
  assert.equal(regimeScore({ volZ: null, trend: 0.5 }), null);
  assert.equal(regimeScore({ volZ: 1.2, trend: null }), null);

  // Lower clamp: volZ = -10 -> volComponent = 0, trend = 0, no CUSUM -> 0
  assert.equal(regimeScore({ volZ: -10, trend: 0, barsSinceCusum: null }), 0);

  // Upper clamp: volZ = 20 -> 1, |trend| = 1 -> 1, barsSinceCusum = 0 -> 1 => 100
  assert.equal(regimeScore({ volZ: 20, trend: -1, barsSinceCusum: 0 }), 100);

  // Exact midpoint check:
  // volZ = 1 => (1 + 1)/4 = 0.5; trend = -0.8 => 0.8; barsSinceCusum = 5 (decay=10) => 0.5
  // 100 * (0.45*0.5 + 0.35*0.8 + 0.20*0.5) = 100 * (0.225 + 0.28 + 0.10) = 60.5
  const mid = regimeScore({ volZ: 1, trend: -0.8, barsSinceCusum: 5, cusumDecayBars: 10 });
  assert.ok(mid !== null);
  assert.ok(Math.abs(mid - 60.5) < 1e-12);
});

test('computeRegimeSeries integrates series, markers, and insufficient-data metadata cleanly', () => {
  const shortCandles = makeCandles([100, 102, 104, 106, 108]);
  const res = computeRegimeSeries(shortCandles, {
    volWindow: 3,
    volLookback: 4,
    trendWindow: 4,
    cusumVolWindow: 3,
  });

  assert.equal(res.meta.candleCount, 5);
  assert.equal(res.meta.requiredBarsForVolZ, 7);
  assert.equal(res.meta.requiredBarsForTrend, 4);
  assert.equal(res.latest.volZ, null);
  assert.equal(res.latest.trend, 1);
  assert.equal(res.latest.score, null);
});
