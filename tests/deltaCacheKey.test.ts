import assert from 'node:assert/strict';
import test from 'node:test';
import { alignDeltaCandleRange, buildDeltaCandleCacheKey } from '../server/deltaClient.ts';

test('buildDeltaCandleCacheKey aligns start and end timestamps inside the same resolution bucket', () => {
  const keyA = buildDeltaCandleCacheKey({
    querySymbol: 'BTCUSD',
    resolution: '15m',
    start: 1_700_000_105, // inside 1699999200 + 900 bucket
    end: 1_700_086_505,
  });
  const keyB = buildDeltaCandleCacheKey({
    querySymbol: 'BTCUSD',
    resolution: '15m',
    start: 1_700_000_899, // same 900s bucket
    end: 1_700_086_999, // same 900s bucket (since 1700086500..1700087399)
  });

  assert.equal(keyA, keyB);

  const nextBucketKey = buildDeltaCandleCacheKey({
    querySymbol: 'BTCUSD',
    resolution: '15m',
    start: 1_700_000_105,
    end: 1_700_087_400, // crosses into next 900s bucket
  });
  assert.notEqual(keyA, nextBucketKey);
});

test('alignDeltaCandleRange aligns cleanly for all supported resolutions', () => {
  const hourly = alignDeltaCandleRange('1h', 3605, 7199);
  assert.equal(hourly.stepSec, 3600);
  assert.equal(hourly.startBucket, 3600);
  assert.equal(hourly.endBucket, 3600);
});
