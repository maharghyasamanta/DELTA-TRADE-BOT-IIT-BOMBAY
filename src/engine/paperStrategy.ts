import type {
  PaperGuardrailSnapshot,
  PaperParameterVersion,
  PaperPosition,
  PaperSignalSnapshot,
  PaperStrategyParams,
} from '../contracts/paper';
import { evaluateGuardrails, type GuardrailThresholds } from './guardrails';
import {
  computeRegimeSeries,
  DEFAULT_CUSUM_DECAY_BARS,
  DEFAULT_CUSUM_H,
  DEFAULT_CUSUM_K,
  DEFAULT_CUSUM_VOL_WINDOW,
  DEFAULT_TREND_WINDOW,
  DEFAULT_VOL_LOOKBACK,
  DEFAULT_VOL_WINDOW,
  logReturns,
  type CandlePoint,
} from './regime';
import {
  DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
  DEFAULT_PAUSE_SCORE,
  DEFAULT_PAUSE_VOL_Z,
  DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
  DEFAULT_REDUCE_SCORE,
  DEFAULT_REDUCE_VOL_Z,
} from './guardrails';

export interface StrategyDecision {
  action: 'LONG' | 'SHORT' | 'FLAT' | 'HOLD';
  desiredSizeFractionBps: number;
  stopLossOffsetTicks: number | null;
  takeProfitOffsetTicks: number | null;
  reason: string;
}

export interface PaperStrategyContext {
  closedCandles: readonly CandlePoint[];
  signal: PaperSignalSnapshot;
  guardrail: PaperGuardrailSnapshot;
  currentPosition: PaperPosition | null;
  tickSizeNum: number;
  params: PaperStrategyParams;
}

export interface PaperStrategy {
  readonly id: PaperStrategyParams['strategyId'];
  readonly name: string;
  readonly isPlaceholder: boolean;
  onCandle(ctx: PaperStrategyContext): StrategyDecision;
}

export function createDefaultParameterVersion(): PaperParameterVersion {
  return {
    versionId: 'v1-baseline',
    label: 'Baseline Trend Follow v1',
    createdAtSec: 0,
    regimeOptions: {
      volWindow: DEFAULT_VOL_WINDOW,
      volLookback: DEFAULT_VOL_LOOKBACK,
      trendWindow: DEFAULT_TREND_WINDOW,
      cusumVolWindow: DEFAULT_CUSUM_VOL_WINDOW,
      cusumK: DEFAULT_CUSUM_K,
      cusumH: DEFAULT_CUSUM_H,
      cusumDecayBars: DEFAULT_CUSUM_DECAY_BARS,
    },
    guardrailThresholds: {
      pauseScore: DEFAULT_PAUSE_SCORE,
      pauseVolZ: DEFAULT_PAUSE_VOL_Z,
      pauseChangePointAgeBars: DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
      reduceScore: DEFAULT_REDUCE_SCORE,
      reduceVolZ: DEFAULT_REDUCE_VOL_Z,
      reduceChangePointAgeBars: DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
    },
    strategyParams: {
      strategyId: 'baseline_trend_follow',
      trendEntryThreshold: 0.2,
      stopVolMultiplier: 2.0,
      targetVolMultiplier: 3.0,
      defaultSizeFractionBps: 10000,
    },
    baseSlippageTicks: 2,
    fixedHalfSpreadTicks: 2,
  };
}

/**
 * Compute causal regime & guardrail snapshot from closed candles[0..N-1] ONLY,
 * plus causal trailing return volatility in price ticks for SL/TP distance.
 */
export function computeGuardrailSnapshotForCandles(
  closedCandles: readonly CandlePoint[],
  version: Pick<PaperParameterVersion, 'regimeOptions' | 'guardrailThresholds'>,
  tickSizeNum: number,
): {
  signal: PaperSignalSnapshot;
  guardrail: PaperGuardrailSnapshot;
  trailingSigmaTicks: number;
} {
  const regimeResult = computeRegimeSeries(closedCandles, version.regimeOptions);
  const requiredBars = Math.max(
    regimeResult.meta.requiredBarsForVolZ,
    regimeResult.meta.requiredBarsForTrend,
  );
  const evaluation = evaluateGuardrails(
    {
      score: regimeResult.latest.score,
      volZ: regimeResult.latest.volZ,
      trend: regimeResult.latest.trend,
      changePointsInWindow: regimeResult.latest.cusumCount,
      lastChangePointAgeBars: regimeResult.latest.barsSinceCusum,
      candleCount: closedCandles.length,
      requiredBars,
    },
    version.guardrailThresholds as GuardrailThresholds,
  );

  const signal: PaperSignalSnapshot = {
    score: evaluation.inputs.score,
    volZ: evaluation.inputs.volZ,
    trend: evaluation.inputs.trend,
    changePointsInWindow: evaluation.inputs.changePointsInWindow,
    lastChangePointAgeBars: evaluation.inputs.lastChangePointAgeBars,
    candleCount: closedCandles.length,
  };

  const guardrail: PaperGuardrailSnapshot = {
    decision: evaluation.decision,
    firedRules: [...evaluation.firedRules],
    reasons: [...evaluation.reasons],
    thresholdsUsed: { ...evaluation.thresholdsUsed },
    inputs: signal,
  };

  // Estimate trailing 1-bar return dispersion in ticks (strictly causal)
  let trailingSigmaTicks = 20;
  if (closedCandles.length >= 10 && Number.isFinite(tickSizeNum) && tickSizeNum > 0) {
    const lr = logReturns(closedCandles);
    const tailReturns = lr.entries.slice(-Math.max(10, version.regimeOptions.volWindow));
    if (tailReturns.length >= 2) {
      let sum = 0;
      for (const r of tailReturns) sum += r.value;
      const mean = sum / tailReturns.length;
      let sq = 0;
      for (const r of tailReturns) {
        const d = r.value - mean;
        sq += d * d;
      }
      const sigma = Math.sqrt(sq / (tailReturns.length - 1));
      const lastClose = closedCandles[closedCandles.length - 1].close;
      if (Number.isFinite(sigma) && sigma > 0 && Number.isFinite(lastClose) && lastClose > 0) {
        trailingSigmaTicks = Math.max(4, Math.round((lastClose * sigma) / tickSizeNum));
      }
    }
  }

  return { signal, guardrail, trailingSigmaTicks };
}

/**
 * Clearly marked swappable placeholder baseline strategy:
 * - Enters in the sign of `trend` (from trendStrength) ONLY when guardrail = CONTINUE
 *   and |trend| >= params.trendEntryThreshold on the latest CLOSED candle.
 * - Exits open positions to FLAT when guardrail = PAUSE or trend flips sign/weakens to 0.
 * - Computes stop/target tick offsets from trailing candle volatility.
 */
export const baselineTrendStrategy: PaperStrategy = {
  id: 'baseline_trend_follow',
  name: 'Baseline Trend Follow (Placeholder)',
  isPlaceholder: true,
  onCandle(ctx: PaperStrategyContext): StrategyDecision {
    const { closedCandles, signal, guardrail, currentPosition, tickSizeNum, params } = ctx;
    if (closedCandles.length === 0) {
      return {
        action: 'HOLD',
        desiredSizeFractionBps: 0,
        stopLossOffsetTicks: null,
        takeProfitOffsetTicks: null,
        reason: 'No closed candles available',
      };
    }

    const trend = signal.trend;
    if (trend === null || !Number.isFinite(trend)) {
      return {
        action: 'HOLD',
        desiredSizeFractionBps: 0,
        stopLossOffsetTicks: null,
        takeProfitOffsetTicks: null,
        reason: 'Trend strength unavailable (warming up)',
      };
    }

    if (currentPosition) {
      if (guardrail.decision === 'PAUSE') {
        return {
          action: 'FLAT',
          desiredSizeFractionBps: 10000,
          stopLossOffsetTicks: null,
          takeProfitOffsetTicks: null,
          reason: 'Guardrail PAUSE active — flatten baseline position',
        };
      }
      if (currentPosition.side === 'LONG' && trend <= 0) {
        return {
          action: 'FLAT',
          desiredSizeFractionBps: 10000,
          stopLossOffsetTicks: null,
          takeProfitOffsetTicks: null,
          reason: `Trend turned non-positive (${trend.toFixed(3)}) — exit LONG`,
        };
      }
      if (currentPosition.side === 'SHORT' && trend >= 0) {
        return {
          action: 'FLAT',
          desiredSizeFractionBps: 10000,
          stopLossOffsetTicks: null,
          takeProfitOffsetTicks: null,
          reason: `Trend turned non-negative (${trend.toFixed(3)}) — exit SHORT`,
        };
      }
      return {
        action: 'HOLD',
        desiredSizeFractionBps: 0,
        stopLossOffsetTicks: null,
        takeProfitOffsetTicks: null,
        reason: `Holding ${currentPosition.side} with trend ${trend.toFixed(3)}`,
      };
    }

    if (guardrail.decision !== 'CONTINUE') {
      return {
        action: 'HOLD',
        desiredSizeFractionBps: 0,
        stopLossOffsetTicks: null,
        takeProfitOffsetTicks: null,
        reason: `Guardrail ${guardrail.decision} blocks new baseline entry`,
      };
    }

    if (Math.abs(trend) < params.trendEntryThreshold) {
      return {
        action: 'HOLD',
        desiredSizeFractionBps: 0,
        stopLossOffsetTicks: null,
        takeProfitOffsetTicks: null,
        reason: `|trend| ${Math.abs(trend).toFixed(3)} < threshold ${params.trendEntryThreshold}`,
      };
    }

    // Estimate volatility-scaled stop/target ticks from trailing closes
    const lr = logReturns(closedCandles);
    const recent = lr.entries.slice(-20);
    let sigma = 0.005;
    if (recent.length >= 2) {
      let sum = 0;
      for (const r of recent) sum += r.value;
      const mean = sum / recent.length;
      let sq = 0;
      for (const r of recent) {
        const d = r.value - mean;
        sq += d * d;
      }
      const computed = Math.sqrt(sq / (recent.length - 1));
      if (Number.isFinite(computed) && computed > 0) {
        sigma = computed;
      }
    }

    const lastClose = closedCandles[closedCandles.length - 1].close;
    const baseVolTicks =
      Number.isFinite(tickSizeNum) && tickSizeNum > 0 && Number.isFinite(lastClose) && lastClose > 0
        ? Math.max(4, Math.round((lastClose * sigma) / tickSizeNum))
        : 20;

    const stopLossOffsetTicks = Math.max(4, Math.round(baseVolTicks * params.stopVolMultiplier));
    const takeProfitOffsetTicks = Math.max(8, Math.round(baseVolTicks * params.targetVolMultiplier));

    return {
      action: trend > 0 ? 'LONG' : 'SHORT',
      desiredSizeFractionBps: params.defaultSizeFractionBps,
      stopLossOffsetTicks,
      takeProfitOffsetTicks,
      reason: `Guardrail CONTINUE + trend ${trend.toFixed(3)} >= ${params.trendEntryThreshold}`,
    };
  },
};

export function getPaperStrategy(id: PaperParameterVersion['strategyParams']['strategyId']): PaperStrategy {
  switch (id) {
    case 'baseline_trend_follow':
    default:
      return baselineTrendStrategy;
  }
}
