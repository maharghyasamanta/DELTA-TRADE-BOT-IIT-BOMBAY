import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeltaProductSummary } from '../src/contracts/delta.ts';
import type { PaperClosedTrade, PaperGuardrailSnapshot } from '../src/contracts/paper.ts';
import { FIXED_SCALE, unitsToString } from '../src/engine/decimal.ts';
import {
  computePaperDriftReport,
  computePaperTradeAnalytics,
  evaluateHeldOutSplit,
  MAX_WALK_FORWARD_GRID_CANDIDATES,
  MIN_PAPER_TRADE_SAMPLE,
  runCausalBacktest,
  runFocusedWalkForwardSearch,
} from '../src/engine/paperAnalytics.ts';
import { buildContractSpecFromProduct } from '../src/engine/paperBrokerEngine.ts';
import { createDefaultParameterVersion } from '../src/engine/paperStrategy.ts';
import type { CandlePoint } from '../src/engine/regime.ts';
import { runWalkForwardInWorker } from '../server/paper/paperRunner.ts';

function makeProduct(): DeltaProductSummary {
  return {
    id: 27,
    symbol: 'BTCUSD',
    description: 'Bitcoin Perpetual',
    shortDescription: null,
    contractType: 'perpetual_futures',
    underlyingSymbol: 'BTC',
    settlingSymbol: 'USDT',
    strikePrice: null,
    settlementTime: null,
    tickSize: '0.5',
    contractValue: '0.001',
    makerCommissionRate: '0.0002',
    takerCommissionRate: '0.0005',
    initialMargin: '0.5',
    initialMarginScalingFactor: '0',
    maintenanceMargin: '0.25',
    maintenanceMarginScalingFactor: '0',
    liquidationPenaltyFactor: '0.5',
    defaultLeverage: '20',
    positionSizeLimit: 100000,
    tradingStatus: 'operational',
    rateExchangeInterval: 28800,
    sortPriority: 1,
  };
}

function makeGuardrail(decision: PaperGuardrailSnapshot['decision'], score: number): PaperGuardrailSnapshot {
  return {
    decision,
    firedRules: ['NONE'],
    reasons: ['Synthetic'],
    thresholdsUsed: {
      pauseScore: 70,
      pauseVolZ: 2,
      pauseChangePointAgeBars: 3,
      reduceScore: 45,
      reduceVolZ: 1.25,
      reduceChangePointAgeBars: 6,
    },
    inputs: {
      score,
      volZ: 0.3,
      trend: 0.4,
      changePointsInWindow: 0,
      lastChangePointAgeBars: null,
      candleCount: 100,
    },
  };
}

function makeTrades(count: number, netUnitsEach: bigint): PaperClosedTrade[] {
  const trades: PaperClosedTrade[] = [];
  for (let i = 0; i < count; i += 1) {
    const win = i % 3 !== 0;
    const net = win ? netUnitsEach : -netUnitsEach / 2n;
    trades.push({
      tradeId: `trd_${i}`,
      sessionId: 'sess_1',
      symbol: 'BTCUSD',
      side: 'LONG',
      contracts: 2,
      entryPriceTicks: 120_000,
      exitPriceTicks: win ? 120_100 : 119_950,
      grossPnlUnits: unitsToString(net + 100_000n),
      totalFeesUnits: '100000',
      totalSlippageUnits: '50000',
      fundingPnlUnits: '0',
      liquidationPenaltyUnits: '0',
      netPnlUnits: unitsToString(net),
      exitReason: win ? 'TARGET' : 'STOP',
      replayed: false,
      parameterVersionId: 'v1-baseline',
      entryGuardrail: makeGuardrail(i % 2 === 0 ? 'CONTINUE' : 'REDUCE_SIZE', i % 2 === 0 ? 18 : 55),
      exitGuardrail: makeGuardrail('CONTINUE', 20),
      openedAtSec: 1_700_000_000 + i * 1800,
      closedAtSec: 1_700_000_900 + i * 1800,
    });
  }
  return trades;
}

function makeWaveCandles(count: number): CandlePoint[] {
  const out: CandlePoint[] = [];
  const start = 1_700_000_000;
  let price = 60_000;
  for (let i = 0; i < count; i += 1) {
    const leg = Math.floor(i / 45) % 2;
    const step = leg === 0 ? 18 + (i % 4) * 3 : -15 - (i % 4) * 2;
    const open = price;
    const close = Math.max(10_000, open + step);
    const high = Math.max(open, close) + 8;
    const low = Math.min(open, close) - 8;
    out.push({
      time: start + i * 900,
      open,
      high,
      low,
      close,
      volume: 200 + (i % 20) * 5,
    });
    price = close;
  }
  return out;
}

describe('paperAnalytics, causal backtest, 3-split search & worker execution', () => {
  it('enforces N < 30 insufficientSample warning and computes Wilson CIs & buckets cleanly', () => {
    const small = computePaperTradeAnalytics(makeTrades(12, 10n * FIXED_SCALE), [
      { time: 1, equity: 10000, equityUnits: unitsToString(10_000n * FIXED_SCALE) },
      { time: 2, equity: 9900, equityUnits: unitsToString(9_900n * FIXED_SCALE) },
    ]);
    assert.equal(small.insufficientSample, true);
    assert.equal(small.minSampleThreshold, MIN_PAPER_TRADE_SAMPLE);
    assert.ok(small.wilson95);
    assert.ok(small.byGuardrail.length >= 2);
    assert.ok(small.byScoreBucket.length >= 2);

    const large = computePaperTradeAnalytics(makeTrades(32, 10n * FIXED_SCALE), []);
    assert.equal(large.insufficientSample, false);
    assert.equal(large.totalTrades, 32);
    assert.ok(large.profitFactor !== null && large.profitFactor > 1);
  });

  it('runCausalBacktest is strictly causal (prefix candles[0..k] produces identical prefix trades)', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const version = createDefaultParameterVersion();
    const candles = makeWaveCandles(260);
    const k = 180;

    const fullBt = runCausalBacktest({
      contract: spec,
      resolution: '15m',
      version,
      tradeCandles: candles,
      markCandles: candles,
    });
    const prefixBt = runCausalBacktest({
      contract: spec,
      resolution: '15m',
      version,
      tradeCandles: candles.slice(0, k),
      markCandles: candles.slice(0, k),
    });

    const cutoffTime = candles[k - 1].time;
    const fullPrefixTrades = fullBt.trades
      .filter((t) => t.closedAtSec <= cutoffTime)
      .map((t) => ({ entry: t.entryPriceTicks, exit: t.exitPriceTicks, net: t.netPnlUnits }));
    const prefixTrades = prefixBt.trades.map((t) => ({
      entry: t.entryPriceTicks,
      exit: t.exitPriceTicks,
      net: t.netPnlUnits,
    }));

    assert.deepEqual(fullPrefixTrades, prefixTrades);
  });

  it('runs 3-split walk-forward grid search cleanly and logs held-out inspection warnings after look #1', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const base = createDefaultParameterVersion();
    const candles = makeWaveCandles(360);

    const wf = runFocusedWalkForwardSearch({
      contract: spec,
      resolution: '15m',
      baseVersion: base,
      tradeCandles: candles,
      markCandles: candles,
      fixedHalfSpreadTicks: 3,
      nowSec: 1_700_500_000,
    });

    assert.equal(wf.fixedHalfSpreadTicks, 3);
    assert.ok(wf.evaluatedCandidates <= MAX_WALK_FORWARD_GRID_CANDIDATES);
    assert.equal(wf.heldOutWindow.barCount, candles.length - Math.floor(candles.length * 0.75));
    // Verify OOS gate rejects insufficient or negative candidates cleanly
    for (const c of wf.candidates) {
      if (c.outOfSample.tradeCount < 5 || c.outOfSample.netReturnPct <= 0) {
        assert.equal(c.promoted, false);
        assert.ok(c.rejectionReason);
      }
    }

    const look1 = evaluateHeldOutSplit({
      sessionId: 'sess_1',
      contract: spec,
      resolution: '15m',
      version: base,
      tradeCandles: candles,
      markCandles: candles,
      previousInspectionCount: 0,
      nowSec: 1_700_500_010,
    });
    assert.equal(look1.log.inspectionIndex, 1);
    assert.equal(look1.log.warningMessage, null);

    const look2 = evaluateHeldOutSplit({
      sessionId: 'sess_1',
      contract: spec,
      resolution: '15m',
      version: base,
      tradeCandles: candles,
      markCandles: candles,
      previousInspectionCount: 1,
      nowSec: 1_700_500_020,
    });
    assert.equal(look2.log.inspectionIndex, 2);
    assert.match(look2.log.warningMessage ?? '', /multiple testing/i);
  });

  it('executes walk-forward search off the main thread via Node worker_threads', async () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const base = createDefaultParameterVersion();
    const candles = makeWaveCandles(280);

    const report = await runWalkForwardInWorker({
      uid: 'worker_test_uid',
      contract: spec,
      resolution: '15m',
      baseVersion: base,
      tradeCandles: candles,
      markCandles: candles,
      fixedHalfSpreadTicks: 2,
      nowSec: 1_700_600_000,
    });

    assert.equal(report.symbol, 'BTCUSD');
    assert.equal(report.totalBars, 280);
    assert.equal(report.evaluatedCandidates, MAX_WALK_FORWARD_GRID_CANDIDATES);
  });

  it('flags paper-vs-backtest win-rate and cost drift accurately', () => {
    const btTrades = makeTrades(10, 20n * FIXED_SCALE); // ~70% win rate
    const btAnalytics = computePaperTradeAnalytics(btTrades, []);

    const badLiveTrades = makeTrades(10, 20n * FIXED_SCALE).map((t, idx) => ({
      ...t,
      netPnlUnits: idx < 2 ? t.netPnlUnits : unitsToString(-5n * FIXED_SCALE), // 20% win rate
      totalFeesUnits: '500000',
    }));

    const drift = computePaperDriftReport(badLiveTrades, btAnalytics);
    assert.equal(drift.driftFlagged, true);
    assert.ok(drift.driftReasons.length >= 1);
  });
});
