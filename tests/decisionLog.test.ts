import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatFirestoreErrorForUi,
  sanitizeDecisionPayload,
} from '../src/services/decisionPayload.ts';

test('sanitizeDecisionPayload bounds strings and guarantees valid non-empty arrays matching firestore.rules', () => {
  const longText = 'x'.repeat(400);
  const sanitized = sanitizeDecisionPayload({
    source: 'Delta',
    symbol: '  ' + 'B'.repeat(80) + '  ',
    timeframe: ' ',
    decision: 'PAUSE',
    firedRules: ['  ', ...Array.from({ length: 20 }, (_, i) => `RULE_${i}_${longText}`)],
    reasons: ['', ...Array.from({ length: 20 }, (_, i) => `Reason_${i}_${longText}`)],
    inputs: {
      score: 82,
      volZ: 2.8,
      trend: -0.7,
      changePointsInWindow: -2,
      lastChangePointAgeBars: 1,
    },
    thresholdsUsed: {
      pauseScore: 75,
      pauseVolZ: 2.5,
      pauseChangePointAgeBars: 3,
      reduceScore: 50,
      reduceVolZ: 1.5,
      reduceChangePointAgeBars: 10,
    },
    lastCandleTime: 1_700_000_000,
    candleCount: -5,
  });

  assert.equal(sanitized.symbol.length, 40);
  assert.equal(sanitized.timeframe, 'UNKNOWN');
  assert.equal(sanitized.firedRules.length, 16);
  assert.ok(sanitized.firedRules.every((r) => r.length >= 1 && r.length <= 64));
  assert.equal(sanitized.reasons.length, 16);
  assert.ok(sanitized.reasons.every((r) => r.length >= 1 && r.length <= 300));
  assert.equal(sanitized.inputs.changePointsInWindow, 0);
  assert.equal(sanitized.candleCount, 0);

  const emptyArraysFallback = sanitizeDecisionPayload({
    source: 'Alpaca',
    symbol: 'AAPL',
    timeframe: '1Day',
    decision: 'CONTINUE',
    firedRules: ['   ', ''],
    reasons: [],
    inputs: {
      score: 20,
      volZ: 0.2,
      trend: 0.1,
      changePointsInWindow: 0,
      lastChangePointAgeBars: null,
    },
    thresholdsUsed: {
      pauseScore: 75,
      pauseVolZ: 2.5,
      pauseChangePointAgeBars: 3,
      reduceScore: 50,
      reduceVolZ: 1.5,
      reduceChangePointAgeBars: 10,
    },
    lastCandleTime: null,
    candleCount: 100,
  });

  assert.deepEqual(emptyArraysFallback.firedRules, ['UNSPECIFIED']);
  assert.deepEqual(emptyArraysFallback.reasons, ['No reason recorded']);
});

test('formatFirestoreErrorForUi extracts code and clean error message without leaking raw JSON authInfo blobs', () => {
  const wrapped = new Error(
    JSON.stringify({
      error: 'Missing or insufficient permissions.',
      code: 'permission-denied',
      operationType: 'list',
      path: 'users/abc/decisions',
      authInfo: { userId: 'abc', email: 'test@example.com' },
    }),
  );

  const formatted = formatFirestoreErrorForUi(wrapped);
  assert.equal(formatted.code, 'permission-denied');
  assert.equal(formatted.message, 'Missing or insufficient permissions.');
  assert.equal(formatted.message.includes('authInfo'), false);

  const indexErr = formatFirestoreErrorForUi(
    new Error(
      JSON.stringify({
        error: 'The query requires an index.',
        code: 'failed-precondition',
      }),
    ),
  );
  assert.equal(indexErr.code, 'failed-precondition');
  assert.ok(indexErr.message.includes('index setup in Firebase Console'));
});
