import type {
  BucketStats,
  EquityPoint,
  HeldOutEvaluationLog,
  PaperClosedTrade,
  PaperContractSpec,
  PaperDriftReport,
  PaperParameterVersion,
  PaperRiskLimits,
  PaperTradeAnalytics,
  WalkForwardCandidateReport,
  WalkForwardReport,
  WalkForwardSplitSummary,
  WilsonRange,
} from '../contracts/paper';
import {
  divFloor,
  stringToUnits,
  unitsToDecimalNumber,
  unitsToString,
} from './decimal';
import { wilsonInterval95 } from './evaluation';
import {
  createPaperSessionState,
  DEFAULT_STARTING_BALANCE_UNITS,
  processBarStep,
} from './paperBrokerEngine';
import type { CandlePoint } from './regime';

export const MIN_PAPER_TRADE_SAMPLE = 30;
export const MAX_WALK_FORWARD_GRID_CANDIDATES = 27;

function toWilsonRange(successes: number, trials: number): WilsonRange | null {
  const res = wilsonInterval95(successes, trials);
  return res ? { low: res.lower, high: res.upper } : null;
}

function computeMaxDrawdownPctFromCurve(equityCurve: readonly EquityPoint[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0].equity;
  let maxDd = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    if (peak > 0) {
      const dd = ((peak - pt.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function computeSharpeLike(trades: readonly PaperClosedTrade[]): number | null {
  if (trades.length < 2) return null;
  const vals = trades.map((t) => unitsToDecimalNumber(stringToUnits(t.netPnlUnits)));
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let sq = 0;
  for (const v of vals) {
    const d = v - mean;
    sq += d * d;
  }
  const sd = Math.sqrt(sq / (vals.length - 1));
  if (!Number.isFinite(sd) || sd <= 1e-12) return null;
  return (mean / sd) * Math.sqrt(vals.length);
}

function buildBucketStats(
  bucketName: string,
  trades: readonly PaperClosedTrade[],
): BucketStats {
  const count = trades.length;
  let wins = 0;
  let totalNet = 0n;
  for (const t of trades) {
    const net = stringToUnits(t.netPnlUnits);
    totalNet += net;
    if (net > 0n) wins += 1;
  }
  const expectancy = count > 0 ? divFloor(totalNet, BigInt(count)) : 0n;
  const insufficientSample = count < MIN_PAPER_TRADE_SAMPLE;
  return {
    bucket: bucketName,
    tradeCount: count,
    wins,
    winRate: count > 0 ? wins / count : null,
    wilson95: count > 0 ? toWilsonRange(wins, count) : null,
    totalNetPnlUnits: unitsToString(totalNet),
    expectancyUnits: unitsToString(expectancy),
    insufficientSample,
  };
}

function getScoreBucketLabel(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return 'Unknown';
  if (score < 25) return '0–24 (Calm)';
  if (score < 50) return '25–49 (Moderate)';
  if (score < 75) return '50–74 (Elevated)';
  return '75–100 (Extreme)';
}

export function computePaperTradeAnalytics(
  trades: readonly PaperClosedTrade[],
  equityCurve: readonly EquityPoint[],
): PaperTradeAnalytics {
  const totalTrades = trades.length;
  const insufficientSample = totalTrades < MIN_PAPER_TRADE_SAMPLE;

  let wins = 0;
  let losses = 0;
  let grossWins = 0n;
  let grossLossesAbs = 0n;
  let totalNet = 0n;
  let totalFees = 0n;
  let totalSlippage = 0n;
  let totalFunding = 0n;

  const byDecisionMap = new Map<string, PaperClosedTrade[]>([
    ['CONTINUE', []],
    ['REDUCE_SIZE', []],
    ['PAUSE', []],
    ['NO_DECISION', []],
  ]);

  const byScoreMap = new Map<string, PaperClosedTrade[]>([
    ['0–24 (Calm)', []],
    ['25–49 (Moderate)', []],
    ['50–74 (Elevated)', []],
    ['75–100 (Extreme)', []],
    ['Unknown', []],
  ]);

  for (const t of trades) {
    const net = stringToUnits(t.netPnlUnits);
    totalNet += net;
    totalFees += stringToUnits(t.totalFeesUnits);
    totalSlippage += stringToUnits(t.totalSlippageUnits);
    totalFunding += stringToUnits(t.fundingPnlUnits);

    if (net > 0n) {
      wins += 1;
      grossWins += net;
    } else if (net < 0n) {
      losses += 1;
      grossLossesAbs += -net;
    }

    const decKey = t.entryGuardrail.decision;
    const decArr = byDecisionMap.get(decKey) ?? [];
    decArr.push(t);
    byDecisionMap.set(decKey, decArr);

    const scoreKey = getScoreBucketLabel(t.entryGuardrail.inputs.score);
    const scoreArr = byScoreMap.get(scoreKey) ?? [];
    scoreArr.push(t);
    byScoreMap.set(scoreKey, scoreArr);
  }

  const avgWinUnits = wins > 0 ? divFloor(grossWins, BigInt(wins)) : 0n;
  const avgLossUnits = losses > 0 ? -divFloor(grossLossesAbs, BigInt(losses)) : 0n;
  const expectancyUnits = totalTrades > 0 ? divFloor(totalNet, BigInt(totalTrades)) : 0n;

  let profitFactor: number | null = null;
  if (grossLossesAbs > 0n) {
    profitFactor = Number(grossWins) / Number(grossLossesAbs);
  } else if (grossWins > 0n) {
    profitFactor = null;
  }

  const byGuardrail = Array.from(byDecisionMap.entries())
    .filter(([, arr]) => arr.length > 0)
    .map(([label, arr]) => buildBucketStats(label, arr));

  const byScoreBucket = Array.from(byScoreMap.entries())
    .filter(([, arr]) => arr.length > 0)
    .map(([label, arr]) => buildBucketStats(label, arr));

  return {
    totalTrades,
    insufficientSample,
    minSampleThreshold: MIN_PAPER_TRADE_SAMPLE,
    wins,
    losses,
    winRate: totalTrades > 0 ? wins / totalTrades : null,
    wilson95: totalTrades > 0 ? toWilsonRange(wins, totalTrades) : null,
    avgWinUnits: unitsToString(avgWinUnits),
    avgLossUnits: unitsToString(avgLossUnits),
    expectancyUnits: unitsToString(expectancyUnits),
    profitFactor,
    maxDrawdownPct: computeMaxDrawdownPctFromCurve(equityCurve),
    sharpeLike: computeSharpeLike(trades),
    totalNetPnlUnits: unitsToString(totalNet),
    totalFeesUnits: unitsToString(totalFees),
    totalSlippageUnits: unitsToString(totalSlippage),
    totalFundingUnits: unitsToString(totalFunding),
    byGuardrail,
    byScoreBucket,
  };
}

export function runCausalBacktest(params: {
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  version: PaperParameterVersion;
  tradeCandles: readonly CandlePoint[];
  markCandles: readonly CandlePoint[];
  startingBalanceUnits?: string;
  riskLimits?: Partial<PaperRiskLimits>;
  fundingRateRaw?: string | null;
}): {
  trades: PaperClosedTrade[];
  equityCurve: EquityPoint[];
  analytics: PaperTradeAnalytics;
  netReturnPct: number;
} {
  const { contract, resolution, version, tradeCandles, markCandles } = params;
  if (tradeCandles.length === 0) {
    return {
      trades: [],
      equityCurve: [],
      analytics: computePaperTradeAnalytics([], []),
      netReturnPct: 0,
    };
  }

  const markByTime = new Map<number, CandlePoint>();
  for (const mc of markCandles) {
    markByTime.set(mc.time, mc);
  }

  const startUnitsStr = params.startingBalanceUnits ?? unitsToString(DEFAULT_STARTING_BALANCE_UNITS);
  let state = createPaperSessionState({
    sessionId: `bt_${version.versionId}`,
    uid: 'backtest',
    contract,
    resolution,
    startingBalanceUnits: startUnitsStr,
    riskLimits: params.riskLimits,
    createdAtSec: tradeCandles[0].time,
    parameterVersion: version,
  });
  state.account.strategyEnabled = true;

  let pending: ReturnType<typeof processBarStep>['nextPendingOrder'] = null;

  for (let i = 0; i < tradeCandles.length; i += 1) {
    const bar = tradeCandles[i];
    // Cap causal history passed to computeRegimeSeries to <= 240 bars for fast backtest/search
    // while strictly containing only bars <= i (all regime windows <= 80 bars).
    const sliceStart = Math.max(0, i - 240 + 1);
    const historySlice = tradeCandles.slice(sliceStart, i + 1);

    const step = processBarStep({
      state,
      tradeCandle: bar,
      markCandle: markByTime.get(bar.time) ?? null,
      closedHistoryUpToBar: historySlice,
      halfSpreadTicks: version.fixedHalfSpreadTicks,
      fundingRateRaw: params.fundingRateRaw ?? '0.0001',
      replayed: false,
      pendingStrategyOrder: pending,
    });
    state = step.state;
    pending = step.nextPendingOrder;
  }

  const analytics = computePaperTradeAnalytics(state.closedTrades, state.equityCurve);
  const startNum = unitsToDecimalNumber(stringToUnits(startUnitsStr));
  const endNum =
    state.equityCurve.length > 0
      ? state.equityCurve[state.equityCurve.length - 1].equity
      : startNum;
  const netReturnPct = startNum > 0 ? ((endNum - startNum) / startNum) * 100 : 0;

  return {
    trades: state.closedTrades,
    equityCurve: state.equityCurve,
    analytics,
    netReturnPct,
  };
}

function summarizeSplit(
  label: WalkForwardSplitSummary['label'],
  candles: readonly CandlePoint[],
  bt: ReturnType<typeof runCausalBacktest>,
): WalkForwardSplitSummary {
  return {
    label,
    barCount: candles.length,
    startSec: candles[0]?.time ?? 0,
    endSec: candles[candles.length - 1]?.time ?? 0,
    tradeCount: bt.analytics.totalTrades,
    insufficientSample: bt.analytics.insufficientSample,
    netReturnPct: bt.netReturnPct,
    winRate: bt.analytics.winRate,
    wilson95: bt.analytics.wilson95,
    profitFactor: bt.analytics.profitFactor,
    expectancyUnits: bt.analytics.expectancyUnits,
    maxDrawdownPct: bt.analytics.maxDrawdownPct,
  };
}

function evaluateCandidatePromotion(
  inSample: WalkForwardSplitSummary,
  outOfSample: WalkForwardSplitSummary,
): { promoted: boolean; rejectionReason: string | null } {
  if (outOfSample.tradeCount < 5) {
    return {
      promoted: false,
      rejectionReason: `Rejected: OOS trade count (${outOfSample.tradeCount}) too small (< 5)`,
    };
  }
  if (outOfSample.netReturnPct <= 0) {
    return {
      promoted: false,
      rejectionReason: `Rejected: OOS net return (${outOfSample.netReturnPct.toFixed(2)}%) <= 0%`,
    };
  }
  if (outOfSample.profitFactor !== null && outOfSample.profitFactor < 1.05) {
    return {
      promoted: false,
      rejectionReason: `Rejected: OOS profit factor (${outOfSample.profitFactor.toFixed(2)}) < 1.05`,
    };
  }
  if (inSample.netReturnPct > 0 && outOfSample.netReturnPct < inSample.netReturnPct * 0.3) {
    return {
      promoted: false,
      rejectionReason: `Rejected: severe IS-to-OOS decay (${inSample.netReturnPct.toFixed(2)}% -> ${outOfSample.netReturnPct.toFixed(2)}%)`,
    };
  }
  return { promoted: true, rejectionReason: null };
}

export function buildFocusedGridVersions(
  baseVersion: PaperParameterVersion,
  fixedHalfSpreadTicks: number,
  nowSec: number,
): PaperParameterVersion[] {
  const trendThresholds = [0.15, 0.25, 0.4];
  const stopMultipliers = [1.5, 2.0, 2.5];
  const targetMultipliers = [2.5, 3.5, 4.5];
  const versions: PaperParameterVersion[] = [];

  for (const t of trendThresholds) {
    for (const s of stopMultipliers) {
      for (const tp of targetMultipliers) {
        if (versions.length >= MAX_WALK_FORWARD_GRID_CANDIDATES) break;
        const idx = versions.length + 1;
        versions.push({
          ...baseVersion,
          versionId: `wf_c${idx}_${nowSec}`,
          label: `Grid #${idx} (|tr|>=${t}, SL ${s}σ, TP ${tp}σ)`,
          createdAtSec: nowSec,
          fixedHalfSpreadTicks: Math.max(1, Math.floor(fixedHalfSpreadTicks)),
          strategyParams: {
            ...baseVersion.strategyParams,
            trendEntryThreshold: t,
            stopVolMultiplier: s,
            targetVolMultiplier: tp,
          },
        });
      }
    }
  }

  return versions;
}

/**
 * Strict 3-split Walk-Forward search:
 *   Split 1 (0%..50%):  In-Sample
 *   Split 2 (50%..75%): Out-of-Sample
 *   Split 3 (75%..100%): Held-Out (NEVER touched during grid search!)
 */
export function runFocusedWalkForwardSearch(params: {
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  baseVersion: PaperParameterVersion;
  tradeCandles: readonly CandlePoint[];
  markCandles: readonly CandlePoint[];
  fixedHalfSpreadTicks: number;
  riskLimits?: Partial<PaperRiskLimits>;
  nowSec: number;
}): WalkForwardReport {
  const { contract, resolution, baseVersion, tradeCandles, markCandles, fixedHalfSpreadTicks, nowSec } = params;
  const n = tradeCandles.length;
  const split1End = Math.floor(n * 0.5);
  const split2End = Math.floor(n * 0.75);

  const isCandles = tradeCandles.slice(0, split1End);
  const oosCandles = tradeCandles.slice(split1End, split2End);
  const heldOutCandles = tradeCandles.slice(split2End);

  const markByTime = new Map<number, CandlePoint>();
  for (const m of markCandles) markByTime.set(m.time, m);
  const pickMarks = (slice: readonly CandlePoint[]) =>
    slice.map((c) => markByTime.get(c.time)).filter((x): x is CandlePoint => Boolean(x));

  const isMarks = pickMarks(isCandles);
  const oosMarks = pickMarks(oosCandles);

  const evalOne = (
    candidateId: string,
    label: string,
    version: PaperParameterVersion,
  ): WalkForwardCandidateReport => {
    const versionWithSpread: PaperParameterVersion = {
      ...version,
      fixedHalfSpreadTicks: Math.max(1, Math.floor(fixedHalfSpreadTicks)),
    };
    const isBt = runCausalBacktest({
      contract,
      resolution,
      version: versionWithSpread,
      tradeCandles: isCandles,
      markCandles: isMarks,
      riskLimits: params.riskLimits,
    });
    const oosBt = runCausalBacktest({
      contract,
      resolution,
      version: versionWithSpread,
      tradeCandles: oosCandles,
      markCandles: oosMarks,
      riskLimits: params.riskLimits,
    });

    const inSample = summarizeSplit('in_sample', isCandles, isBt);
    const outOfSample = summarizeSplit('out_of_sample', oosCandles, oosBt);
    const promo = evaluateCandidatePromotion(inSample, outOfSample);
    return {
      candidateId,
      label,
      version: versionWithSpread,
      inSample,
      outOfSample,
      promoted: promo.promoted,
      rejectionReason: promo.rejectionReason,
    };
  };

  const baselineCandidate = evalOne('baseline', baseVersion.label, baseVersion);
  const gridVersions = buildFocusedGridVersions(baseVersion, fixedHalfSpreadTicks, nowSec);
  const candidates = gridVersions.map((v, i) => evalOne(`cand_${i + 1}`, v.label, v));

  candidates.sort((a, b) => {
    if (a.promoted !== b.promoted) return a.promoted ? -1 : 1;
    return b.outOfSample.netReturnPct - a.outOfSample.netReturnPct;
  });

  const bestCandidate = candidates.find((c) => c.promoted) ?? null;

  return {
    symbol: contract.symbol,
    resolution,
    totalBars: n,
    fixedHalfSpreadTicks: Math.max(1, Math.floor(fixedHalfSpreadTicks)),
    evaluatedCandidates: candidates.length,
    baselineCandidate,
    bestCandidate,
    candidates,
    heldOutWindow: {
      barCount: heldOutCandles.length,
      startSec: heldOutCandles[0]?.time ?? 0,
      endSec: heldOutCandles[heldOutCandles.length - 1]?.time ?? 0,
    },
    generatedAtIso: new Date(nowSec * 1000).toISOString(),
  };
}

/**
 * Evaluate a single chosen candidate on the untouched final 25% held-out slice.
 * Logs every inspection and issues a bias warning after the first look (index >= 2).
 */
export function evaluateHeldOutSplit(params: {
  sessionId: string;
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  version: PaperParameterVersion;
  tradeCandles: readonly CandlePoint[];
  markCandles: readonly CandlePoint[];
  riskLimits?: Partial<PaperRiskLimits>;
  previousInspectionCount: number;
  nowSec: number;
}): {
  summary: WalkForwardSplitSummary;
  log: HeldOutEvaluationLog;
} {
  const {
    sessionId,
    contract,
    resolution,
    version,
    tradeCandles,
    markCandles,
    riskLimits,
    previousInspectionCount,
    nowSec,
  } = params;

  const split2End = Math.floor(tradeCandles.length * 0.75);
  const heldOutCandles = tradeCandles.slice(split2End);
  const markByTime = new Map<number, CandlePoint>();
  for (const m of markCandles) markByTime.set(m.time, m);
  const heldOutMarks = heldOutCandles
    .map((c) => markByTime.get(c.time))
    .filter((x): x is CandlePoint => Boolean(x));

  const bt = runCausalBacktest({
    contract,
    resolution,
    version,
    tradeCandles: heldOutCandles,
    markCandles: heldOutMarks,
    riskLimits,
  });

  const summary = summarizeSplit('held_out', heldOutCandles, bt);
  const inspectionIndex = Math.max(1, previousInspectionCount + 1);
  const warningMessage =
    inspectionIndex > 1
      ? `Held-out set inspected ${inspectionIndex} times — statistical guarantees are degraded by multiple testing.`
      : null;

  const log: HeldOutEvaluationLog = {
    logId: `heldout_${sessionId}_${inspectionIndex}_${nowSec}`,
    sessionId,
    parameterVersionId: version.versionId,
    symbol: contract.symbol,
    resolution,
    inspectionIndex,
    evaluatedAtSec: nowSec,
    tradeCount: summary.tradeCount,
    netReturnPct: summary.netReturnPct,
    profitFactor: summary.profitFactor,
    maxDrawdownPct: summary.maxDrawdownPct,
    winRate: summary.winRate,
    warningMessage,
  };

  return { summary, log };
}

export function computePaperDriftReport(
  liveTrades: readonly PaperClosedTrade[],
  backtestAnalytics: PaperTradeAnalytics,
): PaperDriftReport {
  const liveCount = liveTrades.length;
  let liveWins = 0;
  let liveCostSum = 0n;
  for (const t of liveTrades) {
    if (stringToUnits(t.netPnlUnits) > 0n) liveWins += 1;
    liveCostSum += stringToUnits(t.totalFeesUnits) + stringToUnits(t.totalSlippageUnits);
  }

  const liveWinRate = liveCount > 0 ? liveWins / liveCount : null;
  const backtestWinRate = backtestAnalytics.winRate;
  const winRateDriftPctPts =
    liveWinRate !== null && backtestWinRate !== null
      ? (liveWinRate - backtestWinRate) * 100
      : null;

  const liveAvgCost = liveCount > 0 ? divFloor(liveCostSum, BigInt(liveCount)) : 0n;
  const btCostTotal =
    stringToUnits(backtestAnalytics.totalFeesUnits) +
    stringToUnits(backtestAnalytics.totalSlippageUnits);
  const backtestAvgCost =
    backtestAnalytics.totalTrades > 0
      ? divFloor(btCostTotal, BigInt(backtestAnalytics.totalTrades))
      : 0n;

  const driftReasons: string[] = [];
  if (liveCount < 5 || backtestAnalytics.totalTrades < 5) {
    driftReasons.push('Insufficient live or backtest trades (< 5) to establish statistically meaningful drift.');
  } else {
    if (winRateDriftPctPts !== null && Math.abs(winRateDriftPctPts) > 15) {
      driftReasons.push(
        `Win-rate divergence of ${winRateDriftPctPts > 0 ? '+' : ''}${winRateDriftPctPts.toFixed(1)} pct pts exceeds ±15 pt drift threshold.`,
      );
    }
    if (backtestAvgCost > 0n && liveAvgCost * 2n > backtestAvgCost * 3n) {
      driftReasons.push('Live average fee + slippage drag exceeds 1.5x backtest baseline cost.');
    }
  }

  return {
    liveTradeCount: liveCount,
    backtestTradeCount: backtestAnalytics.totalTrades,
    liveWinRate,
    backtestWinRate,
    winRateDriftPctPts,
    liveAvgCostUnits: unitsToString(liveAvgCost),
    backtestAvgCostUnits: unitsToString(backtestAvgCost),
    driftFlagged:
      liveCount >= 5 &&
      backtestAnalytics.totalTrades >= 5 &&
      driftReasons.length > 0,
    driftReasons,
  };
}
