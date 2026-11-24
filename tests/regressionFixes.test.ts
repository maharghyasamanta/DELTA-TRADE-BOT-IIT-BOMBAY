import assert from 'node:assert/strict';
import test from 'node:test';
import { getTickDecimals } from '../src/utils/format.ts';
import {
  clampLookbackIdForResolution,
  isLookbackAllowedForResolution,
} from '../src/utils/deltaLookback.ts';
import { executeWalkForwardTaskIfWorker } from '../server/paper/walkForwardWorker.ts';

test('getTickDecimals handles integers, trailing zeros, and scientific notation', () => {
  assert.equal(getTickDecimals('1'), 0);
  assert.equal(getTickDecimals('0.5'), 1);
  assert.equal(getTickDecimals('0.0100'), 2);
  assert.equal(getTickDecimals('1e-5'), 5);
  assert.equal(getTickDecimals('2.5e-4'), 5);
  assert.equal(getTickDecimals(1e-7), 7);
  assert.equal(getTickDecimals('1e+2'), 0);
});

test('Delta lookback clamp respects 4000-candle resolution limits', () => {
  // 1m max is 4000 * 60s = 240,000s (~2.77 days) -> 24h allowed, 3d/7d/30d disallowed
  assert.equal(isLookbackAllowedForResolution('1m', 24 * 3600), true);
  assert.equal(isLookbackAllowedForResolution('1m', 3 * 86_400), false);
  assert.equal(clampLookbackIdForResolution('1m', '7d'), '24h');
  assert.equal(clampLookbackIdForResolution('1m', '6h'), '6h');

  // 5m max is 4000 * 300s = 1,200,000s (~13.88 days) -> 7d allowed, 30d disallowed
  assert.equal(isLookbackAllowedForResolution('5m', 7 * 86_400), true);
  assert.equal(isLookbackAllowedForResolution('5m', 30 * 86_400), false);
  assert.equal(clampLookbackIdForResolution('5m', '30d'), '7d');

  // 15m and higher allow 30d
  assert.equal(clampLookbackIdForResolution('15m', '30d'), '30d');
});

test('executeWalkForwardTaskIfWorker returns false cleanly on main thread', () => {
  assert.equal(executeWalkForwardTaskIfWorker(), false);
});
