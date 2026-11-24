import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeltaProductSummary } from '../src/contracts/delta.ts';
import type { PaperGuardrailSnapshot } from '../src/contracts/paper.ts';
import {
  divCeil,
  divFloor,
  FIXED_SCALE,
  mulUnitsDown,
  mulUnitsUp,
  parseFixedUnits,
  parsePercentToRatioUnits,
  priceUnitsToTicks,
  stringToUnits,
  ticksToPriceUnits,
  unitsToString,
} from '../src/engine/decimal.ts';
import {
  buildContractSpecFromProduct,
  cancelPaperOrder,
  computeMaintenanceMarginUnits,
  createPaperSessionState,
  getDayKeyInTimeZone,
  MAX_REPLAY_DOWNTIME_SEC,
  processBarStep,
  processLiveMarketTick,
  replayMissedHistory,
  submitPaperOrder,
  triggerKillSwitch,
} from '../src/engine/paperBrokerEngine.ts';
import type { CandlePoint } from '../src/engine/regime.ts';

function makeProduct(overrides?: Partial<DeltaProductSummary>): DeltaProductSummary {
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
    initialMarginScalingFactor: '0.00001',
    maintenanceMargin: '0.25',
    maintenanceMarginScalingFactor: '0.000005',
    liquidationPenaltyFactor: '0.5',
    defaultLeverage: '20',
    positionSizeLimit: 100000,
    tradingStatus: 'operational',
    rateExchangeInterval: 28800,
    sortPriority: 1,
    ...overrides,
  };
}

function makeGuardrail(
  decision: PaperGuardrailSnapshot['decision'] = 'CONTINUE',
): PaperGuardrailSnapshot {
  return {
    decision,
    firedRules: [decision === 'CONTINUE' ? 'NONE' : `${decision}_RULE`],
    reasons: [`Synthetic ${decision} guardrail`],
    thresholdsUsed: {
      pauseScore: 70,
      pauseVolZ: 2.0,
      pauseChangePointAgeBars: 3,
      reduceScore: 45,
      reduceVolZ: 1.25,
      reduceChangePointAgeBars: 6,
    },
    inputs: {
      score: decision === 'PAUSE' ? 85 : decision === 'REDUCE_SIZE' ? 55 : 20,
      volZ: 0.4,
      trend: 0.45,
      changePointsInWindow: 0,
      lastChangePointAgeBars: null,
      candleCount: 120,
    },
  };
}

function makeTrendingCandles(count: number, startSec: number, stepSec: number): CandlePoint[] {
  const out: CandlePoint[] = [];
  const steps = [32, -14, 28, -10, 36, -16];
  let price = 60_000;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const delta = steps[i % steps.length];
    const close = open + delta;
    const high = Math.max(open, close) + 5;
    const low = Math.min(open, close) - 4;
    out.push({
      time: startSec + i * stepSec,
      open,
      high,
      low,
      close,
      volume: 100 + i,
    });
    price = close;
  }
  return out;
}

describe('decimal BigInt fixed-point & asymmetric rounding', () => {
  it('parses decimal and scientific strings into 10^8 units and serializes cleanly', () => {
    assert.equal(parseFixedUnits('61399.5'), 6_139_950_000_000n);
    assert.equal(parseFixedUnits('0.0002'), 20_000n);
    assert.equal(parseFixedUnits('1.25e-6'), 125n);
    assert.equal(parseFixedUnits('-12.5'), -1_250_000_000n);
    assert.equal(unitsToString(parseFixedUnits('10000')), '1000000000000');
    assert.equal(stringToUnits('1000000000000'), 10_000n * FIXED_SCALE);
  });

  it('rounds costs UP (ceil) and payouts DOWN (floor)', () => {
    assert.equal(divFloor(10n, 3n), 3n);
    assert.equal(divCeil(10n, 3n), 4n);
    assert.equal(divFloor(-10n, 3n), -4n);

    // 0.00000001 * 0.50 -> exact half-unit = 0.000000005
    assert.equal(mulUnitsDown(1n, 50_000_000n), 0n);
    assert.equal(mulUnitsUp(1n, 50_000_000n), 1n);

    // Percent parser divides by 100 rounding up
    assert.equal(parsePercentToRatioUnits('0.25'), 250_000n); // 0.0025 * 10^8
  });

  it('converts prices to integer ticks cleanly', () => {
    const tickSizeUnits = parseFixedUnits('0.5');
    assert.equal(priceUnitsToTicks(parseFixedUnits('60000.5'), tickSizeUnits, 'nearest'), 120_001);
    assert.equal(ticksToPriceUnits(120_001, tickSizeUnits), parseFixedUnits('60000.5'));
  });
});

describe('paperBrokerEngine simulation & risk guards', () => {
  it('builds exact contract spec from Delta product string fields', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    assert.equal(spec.symbol, 'BTCUSD');
    assert.equal(spec.tickSizeUnits, '50000000');
    assert.equal(spec.contractValueUnits, '100000');
    assert.equal(spec.makerRateUnits, '20000');
    assert.equal(spec.takerRateUnits, '50000');
    assert.equal(spec.maintenanceMarginRateUnits, '250000');
    assert.equal(spec.liquidationPenaltyFactorUnits, '50000000');
    assert.equal(spec.rateExchangeIntervalSec, 28800);
  });

  it('executes MARKET buy at ask + size-scaled slippage with taker fee & enforces clientOrderId idempotency', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_1',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      createdAtSec: startSec,
    });

    // ask = 60,001.0 (120,002 ticks), askSize = 5; order = 12 contracts -> excess > 100% -> scaled slippage
    const res1 = submitPaperOrder(state0, {
      clientOrderId: 'ord_mkt_1',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 12,
      stopLossTicks: 119_900,
      takeProfitTicks: 120_300,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000.0,
        bestAskPrice: 60_001.0,
        markPrice: 60_000.5,
        bidSize: 5,
        askSize: 5,
        fundingRateRaw: '0.0001',
        exchangeTimeSec: startSec + 10,
      },
    });

    assert.equal(res1.idempotentDuplicate, false);
    assert.equal(res1.order.status, 'FILLED');
    assert.ok(res1.fill);
    // baseSlippage=2, askSize=5, contracts=12 => ceil((12-5)/5)=2 => slip=2 + 2*2 = 6 ticks
    assert.equal(res1.fill.slippageTicks, 6);
    assert.equal(res1.fill.priceTicks, 120_002 + 6);
    assert.equal(res1.fill.liquidityRole, 'taker');
    assert.equal(res1.state.openPositions.length, 1);

    // Repeat same clientOrderId -> idempotent duplicate, balance unchanged
    const res2 = submitPaperOrder(res1.state, {
      clientOrderId: 'ord_mkt_1',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 12,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000.0,
        bestAskPrice: 60_001.0,
        markPrice: 60_000.5,
        bidSize: 5,
        askSize: 5,
        fundingRateRaw: '0.0001',
        exchangeTimeSec: startSec + 11,
      },
    });

    assert.equal(res2.idempotentDuplicate, true);
    assert.equal(res2.state.account.balanceUnits, res1.state.account.balanceUnits);
    assert.equal(res2.state.openPositions[0].contracts, 12);
  });

  it('requires STRICT price cross for LIMIT orders (never fills on mere touch) and charges maker fee', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_lim',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      createdAtSec: startSec,
    });

    // Limit BUY at exact ask 60,000.0 (120,000 ticks): askTicks == limitPriceTicks -> MUST remain OPEN
    const sub = submitPaperOrder(state0, {
      clientOrderId: 'ord_lim_1',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'LIMIT',
      contracts: 2,
      limitPriceTicks: 120_000,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 59_999.5,
        bestAskPrice: 60_000.0,
        markPrice: 60_000.0,
        bidSize: 10,
        askSize: 10,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 5,
      },
    });

    assert.equal(sub.order.status, 'OPEN');
    assert.equal(sub.fill, null);
    assert.equal(sub.state.openOrders.length, 1);

    // Tick at exact touch (ask still 60,000.0) -> still NOT filled
    const tickTouch = processLiveMarketTick(
      sub.state,
      {
        bestBidPrice: 59_999.5,
        bestAskPrice: 60_000.0,
        markPrice: 60_000.0,
        bidSize: 10,
        askSize: 10,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 10,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.equal(tickTouch.newFills.length, 0);
    assert.equal(tickTouch.state.openOrders.length, 1);

    // Strict cross (ask 59,999.5 < limit 60,000.0) -> fills at limit with maker fee & 0 slippage
    const tickCross = processLiveMarketTick(
      tickTouch.state,
      {
        bestBidPrice: 59_999.0,
        bestAskPrice: 59_999.5,
        markPrice: 59_999.5,
        bidSize: 10,
        askSize: 10,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 15,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.equal(tickCross.newFills.length, 1);
    assert.equal(tickCross.newFills[0].liquidityRole, 'maker');
    assert.equal(tickCross.newFills[0].slippageTicks, 0);
    assert.equal(tickCross.newFills[0].priceTicks, 120_000);
    assert.equal(tickCross.state.openOrders.length, 0);
    assert.equal(tickCross.state.openPositions.length, 1);

    // Test cancel order helper on another limit order
    const sub2 = submitPaperOrder(tickCross.state, {
      clientOrderId: 'ord_lim_cancel',
      symbol: 'BTCUSD',
      side: 'SELL',
      type: 'LIMIT',
      contracts: 1,
      limitPriceTicks: 130_000,
      reduceOnly: true,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 59_999.0,
        bestAskPrice: 59_999.5,
        markPrice: 59_999.5,
        bidSize: 10,
        askSize: 10,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 20,
      },
    });
    assert.equal(sub2.state.openOrders.length, 1);
    const cancelled = cancelPaperOrder(sub2.state, 'ord_lim_cancel', startSec + 25);
    assert.equal(cancelled.cancelledOrder?.status, 'CANCELLED');
    assert.equal(cancelled.state.openOrders.length, 0);
  });

  it('enforces STOP gap-open slippage and STOP-before-TARGET pessimistic intra-bar ordering', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_bar',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      createdAtSec: startSec,
    });

    // Open LONG 2 contracts at ask 60,000.5 (120,001 + slip 2 = 120,003 ticks = 60,001.5)
    // SL = 119,800 ticks (59,900.0), TP = 120,400 ticks (60,200.0)
    const opened = submitPaperOrder(state0, {
      clientOrderId: 'ord_sl_tp',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 2,
      stopLossTicks: 119_800,
      takeProfitTicks: 120_400,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000.0,
        bestAskPrice: 60_000.5,
        markPrice: 60_000.0,
        bidSize: 100,
        askSize: 100,
        fundingRateRaw: null,
        exchangeTimeSec: startSec,
      },
    });
    assert.equal(opened.state.openPositions.length, 1);

    // Bar hits BOTH SL (low 59,800) AND TP (high 60,300), and opens BELOW stop (gap-open at 59,850 = 119,700 ticks)!
    const barCandles: CandlePoint[] = [
      {
        time: startSec + 900,
        open: 59_850,
        high: 60_300,
        low: 59_800,
        close: 60_250,
        volume: 500,
      },
    ];
    const step = processBarStep({
      state: opened.state,
      tradeCandle: barCandles[0],
      markCandle: barCandles[0],
      closedHistoryUpToBar: barCandles,
      halfSpreadTicks: 2,
      fundingRateRaw: null,
      replayed: false,
    });

    assert.equal(step.newTrades.length, 1);
    assert.equal(step.newTrades[0].exitReason, 'STOP');
    // Gap-open at 59,850 (119,700 ticks) minus baseSlippage(2) = 119,698 ticks
    assert.equal(step.newTrades[0].exitPriceTicks, 119_698);
    assert.equal(step.state.openPositions.length, 0);
  });

  it('triggers liquidation using mark_price + Delta scaled maintenance margin + liquidationPenaltyFactor', () => {
    const spec = buildContractSpecFromProduct(
      makeProduct({
        defaultLeverage: '20',
        initialMargin: '5', // 5% IM
        maintenanceMargin: '2.5', // 2.5% MM
        liquidationPenaltyFactor: '0.5',
      }),
    );
    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_liq',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      startingBalanceUnits: unitsToString(10_000n * FIXED_SCALE),
      riskLimits: { maxLeverage: 20, maxRiskPerTradeBps: 2000 },
      createdAtSec: startSec,
    });

    const opened = submitPaperOrder(state0, {
      clientOrderId: 'ord_liq_open',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 100, // 0.1 BTC notional = 6,000 USDT, margin ~= 300 USDT
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000.0,
        bestAskPrice: 60_000.5,
        markPrice: 60_000.0,
        bidSize: 500,
        askSize: 500,
        fundingRateRaw: null,
        exchangeTimeSec: startSec,
      },
    });
    assert.equal(opened.state.openPositions.length, 1);
    const pos = opened.state.openPositions[0];
    const mmNow = computeMaintenanceMarginUnits(100, pos.markPriceTicks, spec);
    assert.ok(mmNow > 0n);

    // Mark price crashes below liquidation threshold (bid/ask also depressed but check uses mark_price)
    const tickLiq = processLiveMarketTick(
      opened.state,
      {
        bestBidPrice: 57_200.0,
        bestAskPrice: 57_201.0,
        markPrice: 57_200.0,
        bidSize: 500,
        askSize: 500,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 60,
      },
      makeGuardrail('CONTINUE'),
    );

    assert.equal(tickLiq.newTrades.length, 1);
    assert.equal(tickLiq.newTrades[0].exitReason, 'LIQUIDATION');
    assert.ok(stringToUnits(tickLiq.newTrades[0].liquidationPenaltyUnits) > 0n);
    assert.equal(tickLiq.state.openPositions.length, 0);
  });

  it('settles periodic funding at rateExchangeIntervalSec and respects guardrail PAUSE/REDUCE_SIZE + Kill Switch', () => {
    const spec = buildContractSpecFromProduct(makeProduct({ rateExchangeInterval: 28_800 }));
    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_guard',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      createdAtSec: startSec,
    });

    // PAUSE rejects non-reduceOnly entry
    const pausedRes = submitPaperOrder(state0, {
      clientOrderId: 'ord_pause',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 4,
      guardrail: makeGuardrail('PAUSE'),
      quote: {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000.5,
        bidSize: 50,
        askSize: 50,
        fundingRateRaw: '0.001',
        exchangeTimeSec: startSec + 10,
      },
    });
    assert.equal(pausedRes.order.status, 'REJECTED');

    // REDUCE_SIZE halves size from 4 -> 2
    const reducedRes = submitPaperOrder(state0, {
      clientOrderId: 'ord_reduce',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 4,
      guardrail: makeGuardrail('REDUCE_SIZE'),
      quote: {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000.5,
        bidSize: 50,
        askSize: 50,
        fundingRateRaw: '0.001',
        exchangeTimeSec: startSec + 15,
      },
    });
    assert.equal(reducedRes.order.status, 'FILLED');
    assert.equal(reducedRes.order.contracts, 2);

    // Advance by 28,800s -> long pays positive funding rate
    const afterFunding = processLiveMarketTick(
      reducedRes.state,
      {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000.5,
        bidSize: 50,
        askSize: 50,
        fundingRateRaw: '0.001',
        exchangeTimeSec: startSec + 28_800,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.ok(stringToUnits(afterFunding.state.openPositions[0].accruedFundingUnits) < 0n);

    // Kill switch flattens open positions & blocks subsequent orders
    const killed = triggerKillSwitch(
      afterFunding.state,
      {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000.5,
        bidSize: 50,
        askSize: 50,
        fundingRateRaw: '0.001',
        exchangeTimeSec: startSec + 28_810,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.equal(killed.state.account.killSwitchActive, true);
    assert.equal(killed.state.openPositions.length, 0);
    assert.equal(killed.closedTrades[0].exitReason, 'KILL_SWITCH');
  });

  it('evaluates configurable IANA daily-loss resetTimeZone strictly against exchange timestamps', () => {
    // 2026-01-01T18:29:59Z -> 2026-01-01 23:59:59 IST (Asia/Kolkata = UTC+5:30)
    // 2026-01-01T18:30:01Z -> 2026-01-02 00:00:01 IST (Asia/Kolkata), still 2026-01-01 UTC
    const beforeIstMidnightSec = Math.floor(Date.parse('2026-01-01T18:29:59Z') / 1000);
    const afterIstMidnightSec = Math.floor(Date.parse('2026-01-01T18:30:01Z') / 1000);

    assert.equal(getDayKeyInTimeZone(beforeIstMidnightSec, 'Asia/Kolkata'), '2026-01-01');
    assert.equal(getDayKeyInTimeZone(afterIstMidnightSec, 'Asia/Kolkata'), '2026-01-02');
    assert.equal(getDayKeyInTimeZone(afterIstMidnightSec, 'UTC'), '2026-01-01');

    const spec = buildContractSpecFromProduct(makeProduct());
    const state0 = createPaperSessionState({
      sessionId: 'sess_tz',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      resetTimeZone: 'Asia/Kolkata',
      createdAtSec: beforeIstMidnightSec,
    });
    state0.account.dailyLossHalted = true;

    // Tick after IST midnight clears dailyLossHalted and updates currentDayKey
    const ticked = processLiveMarketTick(
      state0,
      {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000,
        bidSize: 50,
        askSize: 50,
        fundingRateRaw: null,
        exchangeTimeSec: afterIstMidnightSec,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.equal(ticked.state.account.currentDayKey, '2026-01-02');
    assert.equal(ticked.state.account.dailyLossHalted, false);
  });

  it('replays missed candles + MARK bars on reconnect (<7d) tagging replayed: true, and halts stale (>7d)', () => {
    const spec = buildContractSpecFromProduct(makeProduct());
    const stepSec = 900;
    const startSec = 1_700_000_000;
    const candles = makeTrendingCandles(110, startSec, stepSec);

    const state0 = createPaperSessionState({
      sessionId: 'sess_replay',
      uid: 'user_1',
      contract: spec,
      resolution: '15m',
      createdAtSec: candles[0].time,
    });
    state0.account.strategyEnabled = true;
    state0.account.lastProcessedCandleTime = candles[85].time;

    const replayed = replayMissedHistory({
      snapshot: state0,
      tradeCandles: candles,
      markCandles: candles,
      nowSec: candles[candles.length - 1].time + 60,
      fundingRateRaw: '0.0001',
    });

    assert.equal(replayed.state.account.stale, false);
    assert.equal(replayed.replayedBars, candles.length - 86);
    assert.ok(replayed.replayedFills.length >= 1, 'Expected baseline strategy to execute during replay');
    for (const f of replayed.replayedFills) {
      assert.equal(f.replayed, true);
    }

    // Now simulate > 7 days downtime -> stale: true and zero bars replayed
    const staleResult = replayMissedHistory({
      snapshot: state0,
      tradeCandles: candles,
      markCandles: candles,
      nowSec: candles[85].time + MAX_REPLAY_DOWNTIME_SEC + 120,
      fundingRateRaw: '0.0001',
    });
    assert.equal(staleResult.state.account.stale, true);
    assert.equal(staleResult.state.account.strategyEnabled, false);
    assert.equal(staleResult.replayedBars, 0);
  });

  it('tracks rateExchangeIntervalSource ("api" vs "fallback_28800s") and bumps sessionVersion monotonically', () => {
    const apiSpec = buildContractSpecFromProduct(makeProduct({ rateExchangeInterval: 28800 }));
    assert.equal(apiSpec.rateExchangeIntervalSec, 28800);
    assert.equal(apiSpec.rateExchangeIntervalSource, 'api');

    const fallbackSpec = buildContractSpecFromProduct(makeProduct({ rateExchangeInterval: null }));
    assert.equal(fallbackSpec.rateExchangeIntervalSec, 28800);
    assert.equal(fallbackSpec.rateExchangeIntervalSource, 'fallback_28800s');

    const startSec = 1_700_000_000;
    const state0 = createPaperSessionState({
      sessionId: 'sess_ver',
      uid: 'user_ver',
      contract: apiSpec,
      resolution: '15m',
      createdAtSec: startSec,
    });
    assert.equal(state0.account.sessionVersion, 1);

    // Submit OPEN limit order -> bumps sessionVersion to 2
    const lim = submitPaperOrder(state0, {
      clientOrderId: 'ord_ver_lim',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'LIMIT',
      contracts: 2,
      limitPriceTicks: 119_000,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000,
        bidSize: 10,
        askSize: 10,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 5,
      },
    });
    assert.equal(lim.state.account.sessionVersion, 2);

    // Cancel limit order -> bumps sessionVersion to 3
    const cancelled = cancelPaperOrder(lim.state, 'ord_ver_lim', startSec + 10);
    assert.equal(cancelled.state.account.sessionVersion, 3);

    // Market order fill -> bumps sessionVersion to 4
    const mkt = submitPaperOrder(cancelled.state, {
      clientOrderId: 'ord_ver_mkt',
      symbol: 'BTCUSD',
      side: 'BUY',
      type: 'MARKET',
      contracts: 2,
      stopLossTicks: 119_800,
      guardrail: makeGuardrail('CONTINUE'),
      quote: {
        bestBidPrice: 60_000,
        bestAskPrice: 60_001,
        markPrice: 60_000,
        bidSize: 100,
        askSize: 100,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 15,
      },
    });
    assert.equal(mkt.state.account.sessionVersion, 4);

    // Tick triggering SL -> bumps sessionVersion to 5
    const bar: CandlePoint = {
      time: startSec + 900,
      open: 59_950,
      high: 59_960,
      low: 59_850,
      close: 59_910,
      volume: 100,
    };
    const barRes = processBarStep({
      state: mkt.state,
      tradeCandle: bar,
      markCandle: bar,
      closedHistoryUpToBar: [bar],
      halfSpreadTicks: 2,
      fundingRateRaw: null,
      replayed: false,
    });
    assert.equal(barRes.state.account.sessionVersion, 5);

    // Kill switch -> bumps sessionVersion to 6
    const killed = triggerKillSwitch(
      barRes.state,
      {
        bestBidPrice: 59_900,
        bestAskPrice: 59_901,
        markPrice: 59_900,
        bidSize: 100,
        askSize: 100,
        fundingRateRaw: null,
        exchangeTimeSec: startSec + 910,
      },
      makeGuardrail('CONTINUE'),
    );
    assert.equal(killed.state.account.sessionVersion, 6);
  });
});
