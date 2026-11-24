import { randomUUID } from 'node:crypto';
import {
  DELTA_RESOLUTION_SECONDS,
  fetchLiveProducts,
  fetchTickerSnapshot,
} from '../deltaClient.ts';
import type {
  HeldOutEvaluationLog,
  PaperContractSpec,
  PaperDriftReport,
  PaperParameterVersion,
  PaperRiskLimits,
  PaperSessionState,
  PaperTradeAnalytics,
  WalkForwardReport,
  WalkForwardSplitSummary,
} from '../../src/contracts/paper.ts';
import { parseFixedUnits, unitsToString } from '../../src/engine/decimal.ts';
import {
  computePaperDriftReport,
  computePaperTradeAnalytics,
  evaluateHeldOutSplit,
  runCausalBacktest,
} from '../../src/engine/paperAnalytics.ts';
import {
  buildContractSpecFromProduct,
  cancelPaperOrder,
  createPaperSessionState,
  getDayKeyInTimeZone,
  MAX_REPLAY_DOWNTIME_SEC,
  normalizeRiskLimits,
  processBarStep,
  processLiveMarketTick,
  quoteFromTickerSnapshot,
  replayMissedHistory,
  submitPaperOrder,
  triggerKillSwitch,
  type LiveQuoteInput,
  type SubmitOrderResult,
} from '../../src/engine/paperBrokerEngine.ts';
import {
  computeGuardrailSnapshotForCandles,
  getPaperStrategy,
} from '../../src/engine/paperStrategy.ts';
import {
  fetchPaginatedDeltaCandles,
  runWalkForwardInWorker,
} from './paperRunner.ts';
import type {
  CreateSessionInput,
  HeldOutEvalInput,
  SessionSettingsInput,
  SubmitOrderRequestInput,
  WalkForwardInput,
} from './validators.ts';

export const MAX_PAPER_SESSIONS_PER_USER = 5;
const LIVE_POLL_INTERVAL_MS = 15_000;

export class PaperStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'PAPER_ERROR') {
    super(message);
    this.name = 'PaperStoreError';
    this.status = status;
    this.code = code;
  }
}

interface UserSessionRecord {
  state: PaperSessionState;
  lastClosedBarCheckAtMs: number;
}

const sessionsByUid = new Map<string, Map<string, UserSessionRecord>>();

function getUserMap(uid: string): Map<string, UserSessionRecord> {
  let m = sessionsByUid.get(uid);
  if (!m) {
    m = new Map<string, UserSessionRecord>();
    sessionsByUid.set(uid, m);
  }
  return m;
}

async function resolveContractAndQuote(symbol: string): Promise<{
  contract: PaperContractSpec;
  quote: LiveQuoteInput;
}> {
  const [{ payload }, { ticker }] = await Promise.all([
    fetchLiveProducts(),
    fetchTickerSnapshot(symbol),
  ]);
  const product = payload.products.find((p) => p.symbol === symbol);
  if (!product) {
    throw new PaperStoreError(`Unknown or non-live Delta symbol: ${symbol}`, 404, 'SYMBOL_NOT_FOUND');
  }
  if (product.contractType !== 'perpetual_futures') {
    throw new PaperStoreError(
      `Paper trading supports Delta perpetual_futures first; "${symbol}" is ${product.contractType}.`,
      400,
      'UNSUPPORTED_CONTRACT_TYPE',
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    contract: buildContractSpecFromProduct(product),
    quote: quoteFromTickerSnapshot(ticker, nowSec),
  };
}

async function getLatestGuardrailForSession(state: PaperSessionState) {
  const nowSec = Math.floor(Date.now() / 1000);
  const candles = await fetchPaginatedDeltaCandles({
    symbol: state.account.symbol,
    resolution: state.account.resolution,
    barCount: 160,
    endSec: nowSec,
    basis: 'trade',
  });
  const tickSizeNum = Number(state.contract.tickSizeStr) || 0.5;
  return {
    candles,
    ...computeGuardrailSnapshotForCandles(candles, state.activeVersion, tickSizeNum),
  };
}

async function syncLiveMarketAndStrategy(record: UserSessionRecord): Promise<PaperSessionState> {
  const { state } = record;
  const { ticker } = await fetchTickerSnapshot(state.account.symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const quote = quoteFromTickerSnapshot(ticker, nowSec);

  const { candles, guardrail, signal } = await getLatestGuardrailForSession(state);
  const tickRes = processLiveMarketTick(state, quote, guardrail);
  let nextState = tickRes.state;

  // Evaluate newly closed bar(s) if a candle boundary has closed since lastProcessedCandleTime
  const stepSec = DELTA_RESOLUTION_SECONDS[nextState.account.resolution];
  const latestClosedEndSec = Math.floor(nowSec / stepSec) * stepSec - stepSec;
  const lastProc = nextState.account.lastProcessedCandleTime;

  if (
    candles.length > 0 &&
    !nextState.account.stale &&
    !nextState.account.killSwitchActive
  ) {
    const closedCandles = candles.filter((c) => c.time <= latestClosedEndSec);
    if (closedCandles.length > 0) {
      const latestClosed = closedCandles[closedCandles.length - 1];
      if (lastProc === null) {
        nextState.account.lastProcessedCandleTime = latestClosed.time;
      } else if (latestClosed.time > lastProc) {
        // Process missed closed candles in order
        const markCandles = await fetchPaginatedDeltaCandles({
          symbol: nextState.account.symbol,
          resolution: nextState.account.resolution,
          barCount: 60,
          endSec: nowSec,
          basis: 'mark',
        });
        const markByTime = new Map(markCandles.map((m) => [m.time, m]));
        for (let i = 0; i < closedCandles.length; i += 1) {
          const bar = closedCandles[i];
          if (bar.time <= lastProc) continue;
          const stepRes = processBarStep({
            state: nextState,
            tradeCandle: bar,
            markCandle: markByTime.get(bar.time) ?? null,
            closedHistoryUpToBar: closedCandles.slice(0, i + 1),
            halfSpreadTicks: nextState.activeVersion.fixedHalfSpreadTicks,
            fundingRateRaw: quote.fundingRateRaw,
            replayed: false,
          });
          nextState = stepRes.state;

          // If baseline strategy is enabled and triggered on the latest closed bar, submit live
          if (
            i === closedCandles.length - 1 &&
            nextState.account.strategyEnabled &&
            !nextState.account.dailyLossHalted &&
            !nextState.account.drawdownHalted
          ) {
            const strategy = getPaperStrategy(nextState.activeVersion.strategyParams.strategyId);
            const decision = strategy.onCandle({
              closedCandles: closedCandles.slice(0, i + 1),
              signal,
              guardrail,
              currentPosition: nextState.openPositions[0] ?? null,
              tickSizeNum: Number(nextState.contract.tickSizeStr) || 0.5,
              params: nextState.activeVersion.strategyParams,
            });
            if (decision.action === 'FLAT' && nextState.openPositions[0]) {
              const pos = nextState.openPositions[0];
              const sub = submitPaperOrder(nextState, {
                clientOrderId: `strat_flat_${bar.time}`,
                symbol: nextState.account.symbol,
                side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                type: 'MARKET',
                contracts: pos.contracts,
                reduceOnly: true,
                sourceKind: 'STRATEGY',
                guardrail,
                quote,
              });
              nextState = sub.state;
            } else if (
              (decision.action === 'LONG' || decision.action === 'SHORT') &&
              nextState.openPositions.length === 0
            ) {
              // Auto-size strategy entry using 1% risk budget
              const refPrice = decision.action === 'LONG' ? quote.bestAskPrice : quote.bestBidPrice;
              if (refPrice && refPrice > 0) {
                const tickSizeNum = Number(nextState.contract.tickSizeStr) || 0.5;
                const refTicks = Math.max(1, Math.round(refPrice / tickSizeNum));
                const slTicks =
                  decision.stopLossOffsetTicks !== null
                    ? decision.action === 'LONG'
                      ? Math.max(1, refTicks - decision.stopLossOffsetTicks)
                      : refTicks + decision.stopLossOffsetTicks
                    : null;
                const tpTicks =
                  decision.takeProfitOffsetTicks !== null
                    ? decision.action === 'LONG'
                      ? refTicks + decision.takeProfitOffsetTicks
                      : Math.max(1, refTicks - decision.takeProfitOffsetTicks)
                    : null;
                const sub = submitPaperOrder(nextState, {
                  clientOrderId: `strat_${decision.action}_${bar.time}`,
                  symbol: nextState.account.symbol,
                  side: decision.action === 'LONG' ? 'BUY' : 'SELL',
                  type: 'MARKET',
                  contracts: 1,
                  stopLossTicks: slTicks,
                  takeProfitTicks: tpTicks,
                  sourceKind: 'STRATEGY',
                  guardrail,
                  quote,
                });
                nextState = sub.state;
              }
            }
          }
        }
      }
    }
  }

  record.state = nextState;
  record.lastClosedBarCheckAtMs = Date.now();
  return nextState;
}

// Background polling loop for active user sessions (zero Firestore writes on server)
let pollTimer: ReturnType<typeof setInterval> | null = null;
export function startPaperBrokerLoop(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const userSessions of sessionsByUid.values()) {
      for (const rec of userSessions.values()) {
        if (
          !rec.state.account.stale &&
          (rec.state.openPositions.length > 0 ||
            rec.state.openOrders.length > 0 ||
            rec.state.account.strategyEnabled)
        ) {
          void syncLiveMarketAndStrategy(rec).catch(() => {
            // Keep existing session state on transient Delta network hiccup
          });
        }
      }
    }
  }, LIVE_POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }
}

export function listUserPaperSessions(uid: string): PaperSessionState[] {
  const map = getUserMap(uid);
  return Array.from(map.values())
    .map((r) => r.state)
    .sort((a, b) => b.account.updatedAtSec - a.account.updatedAtSec);
}

export async function createUserPaperSession(
  uid: string,
  input: CreateSessionInput,
): Promise<PaperSessionState> {
  const map = getUserMap(uid);
  if (map.size >= MAX_PAPER_SESSIONS_PER_USER) {
    throw new PaperStoreError(
      `Session cap reached: maximum ${MAX_PAPER_SESSIONS_PER_USER} saved paper sessions per account.`,
      400,
      'SESSION_LIMIT_REACHED',
    );
  }

  const { contract, quote } = await resolveContractAndQuote(input.symbol);
  const nowSec = quote.exchangeTimeSec || Math.floor(Date.now() / 1000);
  const startingBalanceUnits = input.startingBalanceUsdt
    ? unitsToString(parseFixedUnits(input.startingBalanceUsdt, 'trunc'))
    : undefined;

  const tickSizeNum = Number(contract.tickSizeStr) || 0.5;
  const markTicks =
    quote.markPrice && quote.markPrice > 0 ? Math.max(1, Math.round(quote.markPrice / tickSizeNum)) : null;

  const sessionId = `ps_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const state = createPaperSessionState({
    sessionId,
    uid,
    contract,
    resolution: input.resolution,
    startingBalanceUnits,
    resetTimeZone: input.resetTimeZone,
    riskLimits: input.riskLimits,
    initialMarkPriceTicks: markTicks,
    createdAtSec: nowSec,
  });

  // Set lastProcessedCandleTime to latest closed bar so replay only processes future bars
  const stepSec = DELTA_RESOLUTION_SECONDS[input.resolution];
  state.account.lastProcessedCandleTime = Math.floor(nowSec / stepSec) * stepSec - stepSec;

  map.set(sessionId, { state, lastClosedBarCheckAtMs: Date.now() });
  return state;
}

export async function restoreUserPaperSession(
  uid: string,
  sessionId: string,
  snapshot: PaperSessionState | Omit<PaperSessionState, 'equityCurve'>,
): Promise<{
  state: PaperSessionState;
  replayedBars: number;
  replayedTradesCount: number;
}> {
  const map = getUserMap(uid);
  if (!map.has(sessionId) && map.size >= MAX_PAPER_SESSIONS_PER_USER) {
    throw new PaperStoreError(
      `Session cap reached: maximum ${MAX_PAPER_SESSIONS_PER_USER} paper sessions per account.`,
      400,
      'SESSION_LIMIT_REACHED',
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const normalizedSnapshot: PaperSessionState = {
    ...(snapshot as PaperSessionState),
    equityCurve:
      'equityCurve' in snapshot && Array.isArray(snapshot.equityCurve) && snapshot.equityCurve.length > 0
        ? snapshot.equityCurve
        : [
            {
              time: snapshot.account.updatedAtSec,
              equity: Number(snapshot.account.equityUnits) / 1e8,
              equityUnits: snapshot.account.equityUnits,
            },
          ],
  };

  const lastAnchor =
    normalizedSnapshot.account.lastProcessedCandleTime ?? normalizedSnapshot.account.updatedAtSec;
  const elapsedSec = Math.max(0, nowSec - lastAnchor);

  if (elapsedSec > MAX_REPLAY_DOWNTIME_SEC) {
    const staleRes = replayMissedHistory({
      snapshot: normalizedSnapshot,
      tradeCandles: [],
      markCandles: [],
      nowSec,
      fundingRateRaw: null,
    });
    map.set(sessionId, { state: staleRes.state, lastClosedBarCheckAtMs: Date.now() });
    return {
      state: staleRes.state,
      replayedBars: 0,
      replayedTradesCount: 0,
    };
  }

  const stepSec = DELTA_RESOLUTION_SECONDS[normalizedSnapshot.account.resolution];
  const barsNeeded = Math.min(2000, Math.max(80, Math.ceil(elapsedSec / stepSec) + 90));
  const [{ quote }, tradeCandles, markCandles] = await Promise.all([
    resolveContractAndQuote(normalizedSnapshot.account.symbol),
    fetchPaginatedDeltaCandles({
      symbol: normalizedSnapshot.account.symbol,
      resolution: normalizedSnapshot.account.resolution,
      barCount: barsNeeded,
      endSec: nowSec,
      basis: 'trade',
    }),
    fetchPaginatedDeltaCandles({
      symbol: normalizedSnapshot.account.symbol,
      resolution: normalizedSnapshot.account.resolution,
      barCount: barsNeeded,
      endSec: nowSec,
      basis: 'mark',
    }),
  ]);

  const replayRes = replayMissedHistory({
    snapshot: normalizedSnapshot,
    tradeCandles,
    markCandles,
    nowSec,
    fundingRateRaw: quote.fundingRateRaw,
  });

  // Also refresh current mark price if not stale
  let finalState = replayRes.state;
  if (!finalState.account.stale) {
    const { guardrail } = computeGuardrailSnapshotForCandles(
      tradeCandles,
      finalState.activeVersion,
      Number(finalState.contract.tickSizeStr) || 0.5,
    );
    finalState = processLiveMarketTick(finalState, quote, guardrail).state;
  }

  map.set(sessionId, { state: finalState, lastClosedBarCheckAtMs: Date.now() });
  return {
    state: finalState,
    replayedBars: replayRes.replayedBars,
    replayedTradesCount: replayRes.replayedTrades.length,
  };
}

function requireRecord(uid: string, sessionId: string): UserSessionRecord {
  const rec = getUserMap(uid).get(sessionId);
  if (!rec) {
    throw new PaperStoreError(`Paper session "${sessionId}" not found`, 404, 'SESSION_NOT_FOUND');
  }
  return rec;
}

export async function getAndRefreshUserPaperSession(
  uid: string,
  sessionId: string,
): Promise<PaperSessionState> {
  const rec = requireRecord(uid, sessionId);
  return syncLiveMarketAndStrategy(rec);
}

export function deleteUserPaperSession(uid: string, sessionId: string): boolean {
  return getUserMap(uid).delete(sessionId);
}

export async function submitUserPaperOrder(
  uid: string,
  sessionId: string,
  input: SubmitOrderRequestInput,
): Promise<SubmitOrderResult> {
  const rec = requireRecord(uid, sessionId);
  const { ticker } = await fetchTickerSnapshot(rec.state.account.symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const quote = quoteFromTickerSnapshot(ticker, nowSec);
  const { guardrail } = await getLatestGuardrailForSession(rec.state);

  const result = submitPaperOrder(rec.state, {
    clientOrderId: input.clientOrderId,
    symbol: rec.state.account.symbol,
    side: input.side,
    type: input.type,
    contracts: input.contracts,
    limitPriceTicks: input.limitPriceTicks,
    stopLossTicks: input.stopLossTicks,
    takeProfitTicks: input.takeProfitTicks,
    reduceOnly: input.reduceOnly,
    sourceKind: 'MANUAL',
    guardrail,
    quote,
  });

  rec.state = result.state;
  return result;
}

export function cancelUserPaperOrder(
  uid: string,
  sessionId: string,
  clientOrderId: string,
) {
  const rec = requireRecord(uid, sessionId);
  const nowSec = Math.floor(Date.now() / 1000);
  const res = cancelPaperOrder(rec.state, clientOrderId, nowSec);
  if (!res.cancelledOrder) {
    throw new PaperStoreError(`Open order "${clientOrderId}" not found`, 404, 'ORDER_NOT_FOUND');
  }
  rec.state = res.state;
  return res;
}

export async function triggerUserKillSwitch(uid: string, sessionId: string) {
  const rec = requireRecord(uid, sessionId);
  const { ticker } = await fetchTickerSnapshot(rec.state.account.symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const quote = quoteFromTickerSnapshot(ticker, nowSec);
  const { guardrail } = await getLatestGuardrailForSession(rec.state);

  const res = triggerKillSwitch(rec.state, quote, guardrail);
  rec.state = res.state;
  return res;
}

export async function updateUserSessionSettings(
  uid: string,
  sessionId: string,
  input: SessionSettingsInput,
): Promise<PaperSessionState> {
  const rec = requireRecord(uid, sessionId);
  const nowSec = Math.floor(Date.now() / 1000);
  const next: PaperSessionState = {
    ...rec.state,
    account: {
      ...rec.state.account,
      riskLimits: { ...rec.state.account.riskLimits },
    },
    versions: [...rec.state.versions],
  };

  if (input.resetTimeZone !== undefined) {
    next.account.resetTimeZone = input.resetTimeZone;
    next.account.currentDayKey = getDayKeyInTimeZone(nowSec, input.resetTimeZone);
  }
  if (input.riskLimits) {
    next.account.riskLimits = normalizeRiskLimits(
      { ...next.account.riskLimits, ...input.riskLimits },
      next.contract.defaultLeverage,
    );
  }
  if (input.activeVersion) {
    next.activeVersion = input.activeVersion;
    next.account.parameterVersionId = input.activeVersion.versionId;
    if (!next.versions.some((v) => v.versionId === input.activeVersion!.versionId)) {
      next.versions.push(input.activeVersion);
    }
  }
  if (input.resetDailyLossHalt) {
    next.account.dailyLossHalted = false;
    next.account.dailyStartEquityUnits = next.account.equityUnits;
  }
  if (input.resetDrawdownHalt) {
    next.account.drawdownHalted = false;
    next.account.peakEquityUnits = next.account.equityUnits;
  }
  if (input.resetKillSwitch) {
    next.account.killSwitchActive = false;
  }
  if (input.resetStaleSession) {
    next.account.stale = false;
    next.account.staleReason = null;
    const stepSec = DELTA_RESOLUTION_SECONDS[next.account.resolution];
    next.account.lastProcessedCandleTime = Math.floor(nowSec / stepSec) * stepSec - stepSec;
  }
  if (input.strategyEnabled !== undefined) {
    if (next.account.stale || next.account.killSwitchActive) {
      throw new PaperStoreError(
        'Cannot enable strategy while kill switch or stale halt is active',
        400,
        'SESSION_HALTED',
      );
    }
    next.account.strategyEnabled = input.strategyEnabled;
  }
  next.account.updatedAtSec = nowSec;
  rec.state = next;
  return next;
}

export async function getUserSessionAnalyticsAndDrift(
  uid: string,
  sessionId: string,
): Promise<{
  analytics: PaperTradeAnalytics;
  drift: PaperDriftReport;
}> {
  const rec = requireRecord(uid, sessionId);
  const { state } = rec;
  const analytics = computePaperTradeAnalytics(state.closedTrades, state.equityCurve);

  const nowSec = Math.floor(Date.now() / 1000);
  const [tradeCandles, markCandles] = await Promise.all([
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: 400,
      endSec: nowSec,
      basis: 'trade',
    }),
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: 400,
      endSec: nowSec,
      basis: 'mark',
    }),
  ]);

  const bt = runCausalBacktest({
    contract: state.contract,
    resolution: state.account.resolution,
    version: state.activeVersion,
    tradeCandles,
    markCandles,
    startingBalanceUnits: state.account.startingBalanceUnits,
    riskLimits: state.account.riskLimits,
  });

  const drift = computePaperDriftReport(state.closedTrades, bt.analytics);
  return { analytics, drift };
}

export async function runUserWalkForwardSearch(
  uid: string,
  sessionId: string,
  input: WalkForwardInput,
): Promise<WalkForwardReport> {
  const rec = requireRecord(uid, sessionId);
  const { state } = rec;
  const nowSec = Math.floor(Date.now() / 1000);

  const [tradeCandles, markCandles] = await Promise.all([
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: input.lookbackBars,
      endSec: nowSec,
      basis: 'trade',
    }),
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: input.lookbackBars,
      endSec: nowSec,
      basis: 'mark',
    }),
  ]);

  if (tradeCandles.length < 240) {
    throw new PaperStoreError(
      `Insufficient historical candles (${tradeCandles.length}) for 3-split walk-forward evaluation (minimum 240 required).`,
      400,
      'INSUFFICIENT_HISTORY',
    );
  }

  return runWalkForwardInWorker({
    uid,
    contract: state.contract,
    resolution: state.account.resolution,
    baseVersion: state.activeVersion,
    tradeCandles,
    markCandles,
    fixedHalfSpreadTicks: input.fixedHalfSpreadTicks,
    riskLimits: state.account.riskLimits,
    nowSec,
  });
}

export async function evaluateUserHeldOutSplit(
  uid: string,
  sessionId: string,
  input: HeldOutEvalInput,
): Promise<{
  summary: WalkForwardSplitSummary;
  log: HeldOutEvaluationLog;
  account: PaperSessionState['account'];
}> {
  const rec = requireRecord(uid, sessionId);
  const { state } = rec;
  const nowSec = Math.floor(Date.now() / 1000);

  const [tradeCandles, markCandles] = await Promise.all([
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: input.lookbackBars,
      endSec: nowSec,
      basis: 'trade',
    }),
    fetchPaginatedDeltaCandles({
      symbol: state.account.symbol,
      resolution: state.account.resolution,
      barCount: input.lookbackBars,
      endSec: nowSec,
      basis: 'mark',
    }),
  ]);

  if (tradeCandles.length < 240) {
    throw new PaperStoreError(
      `Insufficient historical candles (${tradeCandles.length}) for held-out evaluation (minimum 240 required).`,
      400,
      'INSUFFICIENT_HISTORY',
    );
  }

  const res = evaluateHeldOutSplit({
    sessionId,
    contract: state.contract,
    resolution: state.account.resolution,
    version: input.version,
    tradeCandles,
    markCandles,
    riskLimits: state.account.riskLimits,
    previousInspectionCount: state.account.heldOutInspectionCount,
    nowSec,
  });

  state.account.heldOutInspectionCount = res.log.inspectionIndex;
  state.account.updatedAtSec = nowSec;
  state.heldOutLogs.unshift(res.log);

  return {
    summary: res.summary,
    log: res.log,
    account: state.account,
  };
}

export function buildPaperTradeExplainPayload(
  trade: PaperSessionState['closedTrades'][number],
  contract: { symbol: string; tickSizeStr: string; contractValueStr: string },
) {
  const tickNum = Number(contract.tickSizeStr) || 0.5;
  const decimals = contract.tickSizeStr.includes('.')
    ? contract.tickSizeStr.split('.')[1].length
    : 0;
  const formatUnits = (u: string) => (Number(BigInt(u)) / 1e8).toFixed(4);
  return {
    tradeId: trade.tradeId,
    symbol: contract.symbol,
    side: trade.side,
    contracts: trade.contracts,
    entryPriceDisplay: (trade.entryPriceTicks * tickNum).toFixed(decimals),
    exitPriceDisplay: (trade.exitPriceTicks * tickNum).toFixed(decimals),
    grossPnlDisplay: formatUnits(trade.grossPnlUnits),
    feesDisplay: formatUnits(trade.totalFeesUnits),
    slippageDisplay: formatUnits(trade.totalSlippageUnits),
    fundingDisplay: formatUnits(trade.fundingPnlUnits),
    liquidationPenaltyDisplay: formatUnits(trade.liquidationPenaltyUnits),
    netPnlDisplay: formatUnits(trade.netPnlUnits),
    exitReason: trade.exitReason,
    openedAtSec: trade.openedAtSec,
    closedAtSec: trade.closedAtSec,
    parameterVersionId: trade.parameterVersionId,
    entryGuardrailDecision: trade.entryGuardrail.decision,
    entryScore: trade.entryGuardrail.inputs.score,
    entryVolZ: trade.entryGuardrail.inputs.volZ,
    entryTrend: trade.entryGuardrail.inputs.trend,
    exitGuardrailDecision: trade.exitGuardrail.decision,
    exitScore: trade.exitGuardrail.inputs.score,
    exitVolZ: trade.exitGuardrail.inputs.volZ,
    exitTrend: trade.exitGuardrail.inputs.trend,
    entryFiredRules: [...trade.entryGuardrail.firedRules],
    exitFiredRules: [...trade.exitGuardrail.firedRules],
  };
}
