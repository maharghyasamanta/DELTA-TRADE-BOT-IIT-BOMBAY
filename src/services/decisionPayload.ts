import type { GuardrailDecision, GuardrailEvaluation, GuardrailThresholds } from '../engine/guardrails';

export type DecisionSource = 'Delta' | 'Alpaca';

export interface LogDecisionPayload {
  source: DecisionSource;
  symbol: string;
  timeframe: string;
  decision: GuardrailDecision;
  firedRules: readonly string[];
  reasons: readonly string[];
  inputs: GuardrailEvaluation['inputs'];
  thresholdsUsed: GuardrailThresholds;
  lastCandleTime: number | null;
  candleCount: number;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteOrFallback(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInt(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function sanitizeDecisionPayload(payload: LogDecisionPayload) {
  const cleanedRules = payload.firedRules
    .map((r) => r.trim().slice(0, 64))
    .filter((r) => r.length >= 1)
    .slice(0, 16);
  const cleanedReasons = payload.reasons
    .map((r) => r.trim().slice(0, 300))
    .filter((r) => r.length >= 1)
    .slice(0, 16);

  const rawLastCandle = finiteOrNull(payload.lastCandleTime);
  const lastCandleTime = rawLastCandle !== null && rawLastCandle >= 0 ? rawLastCandle : null;
  const rawAgeBars = finiteOrNull(payload.inputs.lastChangePointAgeBars);
  const lastChangePointAgeBars =
    rawAgeBars !== null && rawAgeBars >= 0 ? Math.floor(rawAgeBars) : null;

  return {
    source: payload.source,
    symbol: (payload.symbol.trim() || 'UNKNOWN').slice(0, 40),
    timeframe: (payload.timeframe.trim() || 'UNKNOWN').slice(0, 40),
    decision: payload.decision,
    firedRules: cleanedRules.length > 0 ? cleanedRules : ['UNSPECIFIED'],
    reasons: cleanedReasons.length > 0 ? cleanedReasons : ['No reason recorded'],
    inputs: {
      score: finiteOrNull(payload.inputs.score),
      volZ: finiteOrNull(payload.inputs.volZ),
      trend: finiteOrNull(payload.inputs.trend),
      changePointsInWindow: nonNegativeInt(payload.inputs.changePointsInWindow),
      lastChangePointAgeBars,
    },
    thresholdsUsed: {
      pauseScore: finiteOrFallback(payload.thresholdsUsed.pauseScore, 80),
      pauseVolZ: finiteOrFallback(payload.thresholdsUsed.pauseVolZ, 2.5),
      pauseChangePointAgeBars: nonNegativeInt(payload.thresholdsUsed.pauseChangePointAgeBars),
      reduceScore: finiteOrFallback(payload.thresholdsUsed.reduceScore, 60),
      reduceVolZ: finiteOrFallback(payload.thresholdsUsed.reduceVolZ, 1.5),
      reduceChangePointAgeBars: nonNegativeInt(payload.thresholdsUsed.reduceChangePointAgeBars),
    },
    lastCandleTime,
    candleCount: nonNegativeInt(payload.candleCount),
  };
}

export function extractFirestoreErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const rawCode = (error as { code?: unknown }).code;
    if (typeof rawCode === 'string' && rawCode.trim()) {
      return rawCode.trim();
    }
  }
  return null;
}

export function formatFirestoreErrorForUi(err: unknown): {
  code: string | null;
  message: string;
} {
  const directCode = extractFirestoreErrorCode(err);
  const rawMessage = err instanceof Error ? err.message : String(err);

  if (rawMessage.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawMessage) as { error?: unknown; code?: unknown };
      const code =
        typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code.trim() : directCode;
      const baseError =
        typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : 'Firestore operation failed';
      if (code === 'failed-precondition' || /index/i.test(baseError)) {
        return {
          code: code ?? 'failed-precondition',
          message: `${baseError} (check Firestore composite/field index setup in Firebase Console)`,
        };
      }
      return { code, message: baseError };
    } catch {
      // Fall through if not JSON
    }
  }

  if (directCode === 'failed-precondition' || /index/i.test(rawMessage)) {
    return {
      code: directCode ?? 'failed-precondition',
      message: `${rawMessage || 'Firestore operation failed'} (check Firestore composite/field index setup in Firebase Console)`,
    };
  }

  return {
    code: directCode,
    message: rawMessage || 'Firestore operation failed',
  };
}
