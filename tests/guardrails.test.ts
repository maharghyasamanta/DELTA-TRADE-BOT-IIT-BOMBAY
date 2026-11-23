import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
  DEFAULT_PAUSE_SCORE,
  DEFAULT_PAUSE_VOL_Z,
  DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
  DEFAULT_REDUCE_SCORE,
  DEFAULT_REDUCE_VOL_Z,
  evaluateGuardrails,
} from '../src/engine/guardrails';

test('evaluateGuardrails returns NO_DECISION when any required regime input is null', () => {
  const resScoreNull = evaluateGuardrails({
    score: null,
    volZ: 0.4,
    trend: 0.1,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
    candleCount: 24,
    requiredBars: 80,
  });

  assert.equal(resScoreNull.decision, 'NO_DECISION');
  assert.deepEqual(resScoreNull.firedRules, ['INSUFFICIENT_DATA']);
  assert.equal(
    resScoreNull.reasons[0],
    'NO DECISION: insufficient data (need 80, have 24)',
  );

  const resVolNull = evaluateGuardrails({
    score: 20,
    volZ: null,
    trend: 0.2,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(resVolNull.decision, 'NO_DECISION');
  assert.deepEqual(resVolNull.firedRules, ['INSUFFICIENT_DATA']);

  const resTrendNull = evaluateGuardrails({
    score: 20,
    volZ: 0.2,
    trend: null,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(resTrendNull.decision, 'NO_DECISION');
  assert.deepEqual(resTrendNull.firedRules, ['INSUFFICIENT_DATA']);
});

test('evaluateGuardrails returns CONTINUE when all inputs stay below REDUCE_SIZE thresholds', () => {
  const res = evaluateGuardrails({
    score: 37.8,
    volZ: 0.92,
    trend: 0.142,
    changePointsInWindow: 1,
    lastChangePointAgeBars: 14,
  });

  assert.equal(res.decision, 'CONTINUE');
  assert.deepEqual(res.firedRules, ['WITHIN_THRESHOLDS']);
  assert.equal(res.reasons.length, 1);
  assert.ok(res.reasons[0].includes('37.8 < 50'));
  assert.ok(res.reasons[0].includes('+0.92σ < +1.50σ'));
  assert.ok(res.reasons[0].includes('+0.142'));
  assert.ok(res.reasons[0].includes('lastChangePointAgeBars 14 > 10'));
});

test('evaluateGuardrails triggers REDUCE_SIZE at exact thresholds and not strictly below', () => {
  // Exact boundary on volZ = 1.50 -> REDUCE_SIZE
  const atVolReduce = evaluateGuardrails({
    score: 49.9,
    volZ: DEFAULT_REDUCE_VOL_Z,
    trend: 0.2,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(atVolReduce.decision, 'REDUCE_SIZE');
  assert.deepEqual(atVolReduce.firedRules, ['REDUCE_ELEVATED_VOL']);
  assert.ok(atVolReduce.reasons[0].includes('+1.50σ >= +1.50σ'));

  // Exact boundary on score = 50 -> REDUCE_SIZE
  const atScoreReduce = evaluateGuardrails({
    score: DEFAULT_REDUCE_SCORE,
    volZ: 1.49,
    trend: 0.5,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(atScoreReduce.decision, 'REDUCE_SIZE');
  assert.deepEqual(atScoreReduce.firedRules, ['REDUCE_ELEVATED_SCORE']);
  assert.ok(atScoreReduce.reasons[0].includes('50.0 >= 50'));

  // Exact boundary on change-point age = 10 -> REDUCE_SIZE; age = 11 -> CONTINUE
  const atAgeReduce = evaluateGuardrails({
    score: 30,
    volZ: 0.5,
    trend: 0.1,
    changePointsInWindow: 1,
    lastChangePointAgeBars: DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
  });
  assert.equal(atAgeReduce.decision, 'REDUCE_SIZE');
  assert.deepEqual(atAgeReduce.firedRules, ['REDUCE_RECENT_CHANGEPOINT']);
  assert.ok(atAgeReduce.reasons[0].includes('10 <= 10'));

  const justBeyondAgeReduce = evaluateGuardrails({
    score: 30,
    volZ: 0.5,
    trend: 0.1,
    changePointsInWindow: 1,
    lastChangePointAgeBars: DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS + 1,
  });
  assert.equal(justBeyondAgeReduce.decision, 'CONTINUE');
});

test('evaluateGuardrails triggers PAUSE at exact pause boundaries', () => {
  // score = 75 -> PAUSE (also fires REDUCE_ELEVATED_SCORE)
  const atPauseScore = evaluateGuardrails({
    score: DEFAULT_PAUSE_SCORE,
    volZ: 1.0,
    trend: 0.8,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(atPauseScore.decision, 'PAUSE');
  assert.deepEqual(atPauseScore.firedRules, ['PAUSE_HIGH_SCORE', 'REDUCE_ELEVATED_SCORE']);

  // volZ = 2.5 -> PAUSE
  const atPauseVol = evaluateGuardrails({
    score: 40,
    volZ: DEFAULT_PAUSE_VOL_Z,
    trend: 0.1,
    changePointsInWindow: 0,
    lastChangePointAgeBars: null,
  });
  assert.equal(atPauseVol.decision, 'PAUSE');
  assert.deepEqual(atPauseVol.firedRules, ['PAUSE_EXTREME_VOL', 'REDUCE_ELEVATED_VOL']);

  // change-point age = 3 -> PAUSE; age = 4 -> REDUCE_SIZE
  const atPauseAge = evaluateGuardrails({
    score: 30,
    volZ: 0.5,
    trend: 0.1,
    changePointsInWindow: 1,
    lastChangePointAgeBars: DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
  });
  assert.equal(atPauseAge.decision, 'PAUSE');
  assert.deepEqual(atPauseAge.firedRules, [
    'PAUSE_RECENT_CHANGEPOINT',
    'REDUCE_RECENT_CHANGEPOINT',
  ]);

  const afterPauseAge = evaluateGuardrails({
    score: 30,
    volZ: 0.5,
    trend: 0.1,
    changePointsInWindow: 1,
    lastChangePointAgeBars: DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS + 1,
  });
  assert.equal(afterPauseAge.decision, 'REDUCE_SIZE');
  assert.deepEqual(afterPauseAge.firedRules, ['REDUCE_RECENT_CHANGEPOINT']);
});

test('evaluateGuardrails honors severity precedence and lists every fired rule with real values', () => {
  const res = evaluateGuardrails({
    score: 82.4,
    volZ: 2.75,
    trend: -0.64,
    changePointsInWindow: 3,
    lastChangePointAgeBars: 2,
  });

  assert.equal(res.decision, 'PAUSE');
  assert.deepEqual(res.firedRules, [
    'PAUSE_HIGH_SCORE',
    'PAUSE_EXTREME_VOL',
    'PAUSE_RECENT_CHANGEPOINT',
    'REDUCE_ELEVATED_SCORE',
    'REDUCE_ELEVATED_VOL',
    'REDUCE_RECENT_CHANGEPOINT',
  ]);
  assert.equal(res.reasons.length, 6);
  assert.equal(res.reasons[0], 'score 82.4 >= 75');
  assert.equal(res.reasons[1], 'volZ +2.75σ >= +2.50σ');
  assert.equal(res.reasons[2], 'lastChangePointAgeBars 2 <= 3');
  assert.equal(res.reasons[3], 'score 82.4 >= 50');
  assert.equal(res.reasons[4], 'volZ +2.75σ >= +1.50σ');
  assert.equal(res.reasons[5], 'lastChangePointAgeBars 2 <= 10');
});

test('evaluateGuardrails supports custom threshold options', () => {
  const res = evaluateGuardrails(
    {
      score: 62.0,
      volZ: 1.8,
      trend: 0.3,
      changePointsInWindow: 0,
      lastChangePointAgeBars: null,
    },
    {
      pauseScore: 60,
      reduceVolZ: 1.75,
    },
  );

  assert.equal(res.decision, 'PAUSE');
  assert.equal(res.thresholdsUsed.pauseScore, 60);
  assert.equal(res.thresholdsUsed.reduceVolZ, 1.75);
  assert.ok(res.reasons.includes('score 62.0 >= 60'));
  assert.ok(res.reasons.includes('volZ +1.80σ >= +1.75σ'));
});
