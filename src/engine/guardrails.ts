/**
 * Pure, deterministic advisory guardrail rules evaluated from Phase 2
 * descriptive regime outputs. Advisory labels only — never places, routes,
 * or simulates any market execution.
 */

export type GuardrailDecision = 'CONTINUE' | 'REDUCE_SIZE' | 'PAUSE' | 'NO_DECISION';

/**
 * Pause if composite descriptive regime intensity reaches >= 75 / 100
 * (upper quartile indicating simultaneous stress across components).
 */
export const DEFAULT_PAUSE_SCORE = 75;

/**
 * Pause if rolling volatility z-score reaches >= +2.5 sigma above the
 * lookback volatility distribution.
 */
export const DEFAULT_PAUSE_VOL_Z = 2.5;

/**
 * Pause if a CUSUM structural change-point occurred within the last 3 bars
 * (inclusive, ageBars <= 3).
 */
export const DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS = 3;

/**
 * Reduce sizing if composite descriptive regime intensity reaches >= 50 / 100.
 */
export const DEFAULT_REDUCE_SCORE = 50;

/**
 * Reduce sizing if rolling volatility z-score reaches >= +1.5 sigma above the
 * lookback volatility distribution.
 */
export const DEFAULT_REDUCE_VOL_Z = 1.5;

/**
 * Reduce sizing if a CUSUM structural change-point occurred within the last 10
 * bars (inclusive, ageBars <= 10), matching the regime score CUSUM decay window.
 */
export const DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS = 10;

export interface GuardrailInputs {
  score: number | null;
  volZ: number | null;
  trend: number | null;
  changePointsInWindow: number;
  lastChangePointAgeBars: number | null;
  candleCount?: number;
  requiredBars?: number;
}

export interface GuardrailThresholds {
  pauseScore: number;
  pauseVolZ: number;
  pauseChangePointAgeBars: number;
  reduceScore: number;
  reduceVolZ: number;
  reduceChangePointAgeBars: number;
}

export type GuardrailOptions = Partial<GuardrailThresholds>;

export interface GuardrailEvaluation {
  decision: GuardrailDecision;
  reasons: string[];
  firedRules: string[];
  inputs: {
    score: number | null;
    volZ: number | null;
    trend: number | null;
    changePointsInWindow: number;
    lastChangePointAgeBars: number | null;
  };
  thresholdsUsed: GuardrailThresholds;
}

interface RuleDefinition {
  name: string;
  severity: Exclude<GuardrailDecision, 'CONTINUE' | 'NO_DECISION'>;
  check: (
    inputs: GuardrailEvaluation['inputs'] & { score: number; volZ: number; trend: number },
    thresholds: GuardrailThresholds,
  ) => string | null;
}

function formatSignedSigma(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}σ`;
}

function formatSignedDecimal(value: number, digits: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

/**
 * Sequential rule definitions checked from highest severity (PAUSE) to medium
 * severity (REDUCE_SIZE). Every matching rule is recorded in reasons; the
 * highest severity among fired rules determines the final advisory decision.
 */
const GUARDRAIL_RULES: readonly RuleDefinition[] = [
  {
    name: 'PAUSE_HIGH_SCORE',
    severity: 'PAUSE',
    check: (inputs, t) =>
      inputs.score >= t.pauseScore
        ? `score ${inputs.score.toFixed(1)} >= ${t.pauseScore}`
        : null,
  },
  {
    name: 'PAUSE_EXTREME_VOL',
    severity: 'PAUSE',
    check: (inputs, t) =>
      inputs.volZ >= t.pauseVolZ
        ? `volZ ${formatSignedSigma(inputs.volZ)} >= ${formatSignedSigma(t.pauseVolZ)}`
        : null,
  },
  {
    name: 'PAUSE_RECENT_CHANGEPOINT',
    severity: 'PAUSE',
    check: (inputs, t) =>
      inputs.lastChangePointAgeBars !== null &&
      inputs.lastChangePointAgeBars <= t.pauseChangePointAgeBars
        ? `lastChangePointAgeBars ${inputs.lastChangePointAgeBars} <= ${t.pauseChangePointAgeBars}`
        : null,
  },
  {
    name: 'REDUCE_ELEVATED_SCORE',
    severity: 'REDUCE_SIZE',
    check: (inputs, t) =>
      inputs.score >= t.reduceScore
        ? `score ${inputs.score.toFixed(1)} >= ${t.reduceScore}`
        : null,
  },
  {
    name: 'REDUCE_ELEVATED_VOL',
    severity: 'REDUCE_SIZE',
    check: (inputs, t) =>
      inputs.volZ >= t.reduceVolZ
        ? `volZ ${formatSignedSigma(inputs.volZ)} >= ${formatSignedSigma(t.reduceVolZ)}`
        : null,
  },
  {
    name: 'REDUCE_RECENT_CHANGEPOINT',
    severity: 'REDUCE_SIZE',
    check: (inputs, t) =>
      inputs.lastChangePointAgeBars !== null &&
      inputs.lastChangePointAgeBars <= t.reduceChangePointAgeBars
        ? `lastChangePointAgeBars ${inputs.lastChangePointAgeBars} <= ${t.reduceChangePointAgeBars}`
        : null,
  },
];

export function resolveGuardrailThresholds(options?: GuardrailOptions): GuardrailThresholds {
  return {
    pauseScore: options?.pauseScore ?? DEFAULT_PAUSE_SCORE,
    pauseVolZ: options?.pauseVolZ ?? DEFAULT_PAUSE_VOL_Z,
    pauseChangePointAgeBars:
      options?.pauseChangePointAgeBars ?? DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
    reduceScore: options?.reduceScore ?? DEFAULT_REDUCE_SCORE,
    reduceVolZ: options?.reduceVolZ ?? DEFAULT_REDUCE_VOL_Z,
    reduceChangePointAgeBars:
      options?.reduceChangePointAgeBars ?? DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
  };
}

/**
 * Evaluate deterministic advisory guardrails on the latest computed regime
 * metrics. Returns NO_DECISION if any required metric is null or non-finite.
 */
export function evaluateGuardrails(
  rawInputs: GuardrailInputs,
  options?: GuardrailOptions,
): GuardrailEvaluation {
  const thresholdsUsed = resolveGuardrailThresholds(options);
  const normalizedInputs: GuardrailEvaluation['inputs'] = {
    score: rawInputs.score,
    volZ: rawInputs.volZ,
    trend: rawInputs.trend,
    changePointsInWindow: rawInputs.changePointsInWindow,
    lastChangePointAgeBars: rawInputs.lastChangePointAgeBars,
  };

  const hasInvalidMetric =
    normalizedInputs.score === null ||
    normalizedInputs.volZ === null ||
    normalizedInputs.trend === null ||
    !Number.isFinite(normalizedInputs.score) ||
    !Number.isFinite(normalizedInputs.volZ) ||
    !Number.isFinite(normalizedInputs.trend) ||
    !Number.isFinite(normalizedInputs.changePointsInWindow) ||
    normalizedInputs.changePointsInWindow < 0 ||
    (normalizedInputs.lastChangePointAgeBars !== null &&
      (!Number.isFinite(normalizedInputs.lastChangePointAgeBars) ||
        normalizedInputs.lastChangePointAgeBars < 0));

  if (hasInvalidMetric) {
    const insufficientReason =
      rawInputs.candleCount !== undefined && rawInputs.requiredBars !== undefined
        ? `NO DECISION: insufficient data (need ${rawInputs.requiredBars}, have ${rawInputs.candleCount})`
        : 'NO DECISION: insufficient data (missing required regime metrics)';

    return {
      decision: 'NO_DECISION',
      firedRules: ['INSUFFICIENT_DATA'],
      reasons: [insufficientReason],
      inputs: normalizedInputs,
      thresholdsUsed,
    };
  }

  const validInputs = {
    score: normalizedInputs.score as number,
    volZ: normalizedInputs.volZ as number,
    trend: normalizedInputs.trend as number,
    changePointsInWindow: normalizedInputs.changePointsInWindow,
    lastChangePointAgeBars: normalizedInputs.lastChangePointAgeBars,
  };

  const firedRules: string[] = [];
  const reasons: string[] = [];
  let hasPause = false;
  let hasReduce = false;

  for (const rule of GUARDRAIL_RULES) {
    const reason = rule.check(validInputs, thresholdsUsed);
    if (reason !== null) {
      firedRules.push(rule.name);
      reasons.push(reason);
      if (rule.severity === 'PAUSE') {
        hasPause = true;
      } else {
        hasReduce = true;
      }
    }
  }

  if (hasPause) {
    return {
      decision: 'PAUSE',
      firedRules,
      reasons,
      inputs: normalizedInputs,
      thresholdsUsed,
    };
  }

  if (hasReduce) {
    return {
      decision: 'REDUCE_SIZE',
      firedRules,
      reasons,
      inputs: normalizedInputs,
      thresholdsUsed,
    };
  }

  const ageClause =
    validInputs.lastChangePointAgeBars !== null
      ? `lastChangePointAgeBars ${validInputs.lastChangePointAgeBars} > ${thresholdsUsed.reduceChangePointAgeBars}`
      : `changePointsInWindow ${validInputs.changePointsInWindow}`;

  return {
    decision: 'CONTINUE',
    firedRules: ['WITHIN_THRESHOLDS'],
    reasons: [
      `score ${validInputs.score.toFixed(1)} < ${thresholdsUsed.reduceScore}, volZ ${formatSignedSigma(validInputs.volZ)} < ${formatSignedSigma(thresholdsUsed.reduceVolZ)}, trend ${formatSignedDecimal(validInputs.trend, 3)}, ${ageClause}`,
    ],
    inputs: normalizedInputs,
    thresholdsUsed,
  };
}
