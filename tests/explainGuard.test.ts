import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ExplainSnapshotRequest,
  ExplainStructuredOutput,
} from '../src/contracts/explain.ts';
import {
  validateDisallowedContent,
  validateExplainOutput,
  validateNumberGrounding,
} from '../src/engine/explainGuard.ts';

function createBaseSnapshot(
  overrides?: Partial<ExplainSnapshotRequest>,
): ExplainSnapshotRequest {
  return {
    source: 'Delta',
    symbol: 'BTCUSD',
    timeframe: '15m (24H)',
    candleCount: 96,
    lastCandleTime: 1763920800,
    regime: {
      score: 62.4,
      volZ: 1.9234,
      trend: -0.412,
      changePointsInWindow: 2,
      lastChangePointAgeBars: 4,
    },
    guardrail: {
      decision: 'REDUCE_SIZE',
      firedRules: ['REDUCE_ELEVATED_SCORE', 'REDUCE_ELEVATED_VOL', 'REDUCE_RECENT_CHANGEPOINT'],
      reasons: ['score 62.4 >= 50', 'volZ +1.92σ >= +1.50σ', 'lastChangePointAgeBars 4 <= 10'],
      thresholdsUsed: {
        pauseScore: 75,
        pauseVolZ: 2.5,
        pauseChangePointAgeBars: 3,
        reduceScore: 50,
        reduceVolZ: 1.5,
        reduceChangePointAgeBars: 10,
      },
    },
    windows: {
      volWindow: 20,
      volLookback: 60,
      trendWindow: 20,
      cusumVolWindow: 20,
      cusumK: 0.5,
      cusumH: 5,
      cusumDecayBars: 10,
      weights: {
        volatility: 0.45,
        trend: 0.35,
        cusum: 0.2,
      },
      requiredBarsForVolZ: 80,
      requiredBarsForTrend: 20,
      requiredBarsForCusum: 22,
      skippedNonPositiveCloses: 0,
    },
    ...overrides,
  };
}

describe('explainGuard', () => {
  it('passes when all numbers match exact or display-rounded snapshot values (e.g. 1.92 vs 1.9234)', () => {
    const snapshot = createBaseSnapshot();
    const output: ExplainStructuredOutput = {
      summary:
        'Over 96 loaded 15m (24H) candles for BTCUSD, the regime score is 62.4 with volatility z-score +1.92 and trend strength -0.412.',
      keyPoints: [
        {
          label: 'Volatility Z-Score',
          valueText: '+1.92',
          meaning: 'Exceeds the REDUCE_SIZE threshold of 1.50 over the 20-bar / 60-bar lookback.',
        },
        {
          label: 'CUSUM Change Points',
          valueText: '2 events, age 4 bars',
          meaning: 'Latest crossing occurred 4 bars ago, within the 10-bar threshold.',
        },
      ],
      cautions: [
        'Metrics summarize only the 96 loaded bars as of 2025-11-23 18:00 UTC.',
      ],
      unavailable: [],
    };

    const result = validateExplainOutput(output, snapshot);
    assert.deepEqual(result, { ok: true });
  });

  it('rejects any ungrounded number with UNGROUNDED_OUTPUT and reports offending numbers', () => {
    const snapshot = createBaseSnapshot();
    const output: ExplainStructuredOutput = {
      summary: 'BTCUSD has a regime score of 62.4 and could move toward 99500.',
      keyPoints: [
        {
          label: 'Volatility Z-Score',
          valueText: '+1.92',
          meaning: 'Computed across 20 bars and 14 days.',
        },
      ],
      cautions: [],
      unavailable: [],
    };

    const grounding = validateNumberGrounding(output, snapshot);
    assert.equal(grounding.ok, false);
    assert.deepEqual(grounding.offendingNumbers, [99500, 14]);

    const full = validateExplainOutput(output, snapshot);
    assert.equal(full.ok, false);
    if (!full.ok) {
      assert.equal(full.code, 'UNGROUNDED_OUTPUT');
      assert.deepEqual(full.offendingNumbers, [99500, 14]);
    }
  });

  it('rejects numbers outside display rounding tolerance (e.g. 1.99 vs 1.9234)', () => {
    const snapshot = createBaseSnapshot();
    const output: ExplainStructuredOutput = {
      summary: 'Volatility z-score is 1.99 on 96 candles.',
      keyPoints: [],
      cautions: [],
      unavailable: [],
    };

    const result = validateExplainOutput(output, snapshot);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'UNGROUNDED_OUTPUT');
      assert.deepEqual(result.offendingNumbers, [1.99]);
    }
  });

  it('rejects disallowed advisory/trading/predictive words case-insensitively with DISALLOWED_CONTENT', () => {
    const snapshot = createBaseSnapshot();
    const forbiddenWords = [
      'Buy',
      'SELL',
      'long',
      'Short',
      'enter',
      'EXIT',
      'order',
      'Position',
      'guaranteed',
      'Predict',
    ];

    for (const word of forbiddenWords) {
      const output: ExplainStructuredOutput = {
        summary: `Score is 62.4; context note includes ${word} wording.`,
        keyPoints: [],
        cautions: [],
        unavailable: [],
      };
      const check = validateDisallowedContent(output);
      assert.equal(check.ok, false, `Expected word "${word}" to fail`);
      assert.ok(check.matchedWords.includes(word.toLowerCase()));

      const full = validateExplainOutput(output, snapshot);
      assert.equal(full.ok, false);
      if (!full.ok) {
        assert.equal(full.code, 'DISALLOWED_CONTENT');
      }
    }
  });

  it('allows null input values to be described as unavailable while keeping required counts grounded', () => {
    const snapshot = createBaseSnapshot({
      candleCount: 40,
      regime: {
        score: null,
        volZ: null,
        trend: 0.25,
        changePointsInWindow: 0,
        lastChangePointAgeBars: null,
      },
      guardrail: {
        decision: 'NO_DECISION',
        firedRules: ['INSUFFICIENT_DATA'],
        reasons: ['NO DECISION: insufficient data (need 80, have 40)'],
        thresholdsUsed: {
          pauseScore: 75,
          pauseVolZ: 2.5,
          pauseChangePointAgeBars: 3,
          reduceScore: 50,
          reduceVolZ: 1.5,
          reduceChangePointAgeBars: 10,
        },
      },
    });

    const output: ExplainStructuredOutput = {
      summary:
        'Guardrail status is NO_DECISION because only 40 candles are loaded out of the 80 needed for volatility z-score.',
      keyPoints: [
        {
          label: 'Trend Strength',
          valueText: '+0.250',
          meaning: 'Computed over the 20-bar trend window.',
        },
      ],
      cautions: ['Volatility z-score and composite score are unavailable below 80 bars.'],
      unavailable: [
        'Regime Score (null — requires 80 bars, have 40)',
        'Volatility Z-Score (null — requires 80 bars, have 40)',
        'Last Change-Point Age (null — 0 events in window)',
      ],
    };

    const result = validateExplainOutput(output, snapshot);
    assert.deepEqual(result, { ok: true });
  });
});
