import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  GEMINI_CONFIGURED,
  GeminiApiError,
  GeminiNotConfiguredError,
  explainSnapshot,
  getExplainTelemetry,
  verifyGeminiModelsIfNeeded,
} from '../geminiClient.ts';
import type {
  ExplainApiEnvelope,
  ExplainApiErrorResponse,
  ExplainSnapshotRequest,
  ExplainStatusResponse,
} from '../../src/contracts/explain.ts';

export const EXPLAIN_BODY_LIMIT_BYTES = 8 * 1024; // 8 KB max request payload
export const EXPLAIN_RATE_LIMIT_MAX_REQUESTS = 10; // per IP
export const EXPLAIN_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute sliding window

const RATE_LIMIT_MAP = new Map<string, number[]>();

const ALLOWED_DECISIONS = new Set(['CONTINUE', 'REDUCE_SIZE', 'PAUSE', 'NO_DECISION']);

const TOP_LEVEL_KEYS = [
  'source',
  'symbol',
  'timeframe',
  'candleCount',
  'lastCandleTime',
  'regime',
  'guardrail',
  'windows',
] as const;

const REGIME_KEYS = [
  'score',
  'volZ',
  'trend',
  'changePointsInWindow',
  'lastChangePointAgeBars',
] as const;

const GUARDRAIL_KEYS = ['decision', 'firedRules', 'reasons', 'thresholdsUsed'] as const;

const THRESHOLD_KEYS = [
  'pauseScore',
  'pauseVolZ',
  'pauseChangePointAgeBars',
  'reduceScore',
  'reduceVolZ',
  'reduceChangePointAgeBars',
] as const;

const WINDOWS_KEYS = [
  'volWindow',
  'volLookback',
  'trendWindow',
  'cusumVolWindow',
  'cusumK',
  'cusumH',
  'cusumDecayBars',
  'weights',
  'requiredBarsForVolZ',
  'requiredBarsForTrend',
  'requiredBarsForCusum',
  'skippedNonPositiveCloses',
] as const;

const WEIGHTS_KEYS = ['volatility', 'trend', 'cusum'] as const;

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
  extra?: { offendingNumbers?: number[]; matchedWords?: string[] },
): void {
  const body: ExplainApiErrorResponse = {
    error,
    code,
    status,
    source: 'Gemini Explain Proxy',
    timestamp: new Date().toISOString(),
    ...(extra?.offendingNumbers ? { offendingNumbers: extra.offendingNumbers } : {}),
    ...(extra?.matchedWords ? { matchedWords: extra.matchedWords } : {}),
  };
  res.status(status).json(body);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, expected: readonly string[]): string | null {
  const actualKeys = Object.keys(obj);
  const expectedSet = new Set(expected);

  for (const key of actualKeys) {
    if (!expectedSet.has(key)) {
      return `Unknown field "${key}"`;
    }
  }
  for (const key of expected) {
    if (!(key in obj)) {
      return `Missing required field "${key}"`;
    }
  }
  return null;
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNum(value: unknown): value is number | null {
  return value === null || isFiniteNum(value);
}

function isNonEmptyBoundedString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function validateExplainSnapshot(body: unknown):
  | { ok: true; value: ExplainSnapshotRequest }
  | { ok: false; message: string } {
  if (!isPlainObject(body)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }

  const topKeyErr = hasExactKeys(body, TOP_LEVEL_KEYS);
  if (topKeyErr) return { ok: false, message: topKeyErr };

  if (body.source !== 'Delta' && body.source !== 'Alpaca') {
    return { ok: false, message: 'source must be "Delta" or "Alpaca"' };
  }
  if (!isNonEmptyBoundedString(body.symbol, 40)) {
    return { ok: false, message: 'symbol must be a non-empty string (<= 40 chars)' };
  }
  if (!isNonEmptyBoundedString(body.timeframe, 64)) {
    return { ok: false, message: 'timeframe must be a non-empty string (<= 64 chars)' };
  }
  if (!isFiniteNum(body.candleCount) || !Number.isInteger(body.candleCount) || body.candleCount < 0) {
    return { ok: false, message: 'candleCount must be a finite non-negative integer' };
  }
  if (!isNullableFiniteNum(body.lastCandleTime) || (body.lastCandleTime !== null && body.lastCandleTime < 0)) {
    return { ok: false, message: 'lastCandleTime must be null or a finite non-negative number' };
  }

  // regime
  if (!isPlainObject(body.regime)) {
    return { ok: false, message: 'regime must be an object' };
  }
  const regimeKeyErr = hasExactKeys(body.regime, REGIME_KEYS);
  if (regimeKeyErr) return { ok: false, message: `regime: ${regimeKeyErr}` };

  if (!isNullableFiniteNum(body.regime.score)) {
    return { ok: false, message: 'regime.score must be null or a finite number' };
  }
  if (!isNullableFiniteNum(body.regime.volZ)) {
    return { ok: false, message: 'regime.volZ must be null or a finite number' };
  }
  if (!isNullableFiniteNum(body.regime.trend)) {
    return { ok: false, message: 'regime.trend must be null or a finite number' };
  }
  if (
    !isFiniteNum(body.regime.changePointsInWindow) ||
    !Number.isInteger(body.regime.changePointsInWindow) ||
    body.regime.changePointsInWindow < 0
  ) {
    return {
      ok: false,
      message: 'regime.changePointsInWindow must be a finite non-negative integer',
    };
  }
  if (
    !isNullableFiniteNum(body.regime.lastChangePointAgeBars) ||
    (body.regime.lastChangePointAgeBars !== null &&
      (!Number.isInteger(body.regime.lastChangePointAgeBars) || body.regime.lastChangePointAgeBars < 0))
  ) {
    return {
      ok: false,
      message: 'regime.lastChangePointAgeBars must be null or a finite non-negative integer',
    };
  }

  // guardrail
  if (!isPlainObject(body.guardrail)) {
    return { ok: false, message: 'guardrail must be an object' };
  }
  const guardrailKeyErr = hasExactKeys(body.guardrail, GUARDRAIL_KEYS);
  if (guardrailKeyErr) return { ok: false, message: `guardrail: ${guardrailKeyErr}` };

  if (typeof body.guardrail.decision !== 'string' || !ALLOWED_DECISIONS.has(body.guardrail.decision)) {
    return { ok: false, message: 'guardrail.decision must be CONTINUE, REDUCE_SIZE, PAUSE, or NO_DECISION' };
  }
  if (
    !Array.isArray(body.guardrail.firedRules) ||
    body.guardrail.firedRules.length === 0 ||
    body.guardrail.firedRules.length > 16 ||
    !body.guardrail.firedRules.every((r) => isNonEmptyBoundedString(r, 80))
  ) {
    return {
      ok: false,
      message: 'guardrail.firedRules must be an array of 1–16 non-empty strings',
    };
  }
  if (
    !Array.isArray(body.guardrail.reasons) ||
    body.guardrail.reasons.length === 0 ||
    body.guardrail.reasons.length > 16 ||
    !body.guardrail.reasons.every((r) => isNonEmptyBoundedString(r, 300))
  ) {
    return {
      ok: false,
      message: 'guardrail.reasons must be an array of 1–16 non-empty strings',
    };
  }
  if (!isPlainObject(body.guardrail.thresholdsUsed)) {
    return { ok: false, message: 'guardrail.thresholdsUsed must be an object' };
  }
  const thresholdKeyErr = hasExactKeys(body.guardrail.thresholdsUsed, THRESHOLD_KEYS);
  if (thresholdKeyErr) return { ok: false, message: `guardrail.thresholdsUsed: ${thresholdKeyErr}` };

  for (const key of THRESHOLD_KEYS) {
    if (!isFiniteNum(body.guardrail.thresholdsUsed[key])) {
      return { ok: false, message: `guardrail.thresholdsUsed.${key} must be a finite number` };
    }
  }

  // windows
  if (!isPlainObject(body.windows)) {
    return { ok: false, message: 'windows must be an object' };
  }
  const windowsKeyErr = hasExactKeys(body.windows, WINDOWS_KEYS);
  if (windowsKeyErr) return { ok: false, message: `windows: ${windowsKeyErr}` };

  const positiveWindowInts = [
    'volWindow',
    'volLookback',
    'trendWindow',
    'cusumVolWindow',
    'cusumDecayBars',
    'requiredBarsForVolZ',
    'requiredBarsForTrend',
    'requiredBarsForCusum',
  ] as const;
  for (const key of positiveWindowInts) {
    const val = body.windows[key];
    if (!isFiniteNum(val) || !Number.isInteger(val) || val < 1) {
      return { ok: false, message: `windows.${key} must be a positive finite integer` };
    }
  }

  const nonNegWindowNums = ['cusumK', 'cusumH'] as const;
  for (const key of nonNegWindowNums) {
    const val = body.windows[key];
    if (!isFiniteNum(val) || val < 0) {
      return { ok: false, message: `windows.${key} must be a non-negative finite number` };
    }
  }

  if (
    !isFiniteNum(body.windows.skippedNonPositiveCloses) ||
    !Number.isInteger(body.windows.skippedNonPositiveCloses) ||
    body.windows.skippedNonPositiveCloses < 0
  ) {
    return {
      ok: false,
      message: 'windows.skippedNonPositiveCloses must be a finite non-negative integer',
    };
  }

  if (!isPlainObject(body.windows.weights)) {
    return { ok: false, message: 'windows.weights must be an object' };
  }
  const weightsKeyErr = hasExactKeys(body.windows.weights, WEIGHTS_KEYS);
  if (weightsKeyErr) return { ok: false, message: `windows.weights: ${weightsKeyErr}` };

  for (const key of WEIGHTS_KEYS) {
    const w = body.windows.weights[key];
    if (!isFiniteNum(w) || w < 0) {
      return { ok: false, message: `windows.weights.${key} must be a non-negative finite number` };
    }
  }

  return { ok: true, value: body as unknown as ExplainSnapshotRequest };
}

function checkRateLimit(clientKey: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const now = Date.now();
  const windowStart = now - EXPLAIN_RATE_LIMIT_WINDOW_MS;
  const existing = RATE_LIMIT_MAP.get(clientKey) ?? [];
  const recent = existing.filter((ts) => ts > windowStart);

  if (recent.length >= EXPLAIN_RATE_LIMIT_MAX_REQUESTS) {
    const oldestInWindow = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldestInWindow + EXPLAIN_RATE_LIMIT_WINDOW_MS - now) / 1000));
    RATE_LIMIT_MAP.set(clientKey, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  RATE_LIMIT_MAP.set(clientKey, recent);

  // Periodically prune stale IPs if map grows large
  if (RATE_LIMIT_MAP.size > 500) {
    for (const [k, timestamps] of RATE_LIMIT_MAP.entries()) {
      if (timestamps.every((ts) => ts <= windowStart)) {
        RATE_LIMIT_MAP.delete(k);
      }
    }
  }

  return { allowed: true };
}

export function createExplainRouter(): Router {
  const router = Router();

  router.get('/explain/status', async (_req: Request, res: Response) => {
    await verifyGeminiModelsIfNeeded();
    const telemetry = getExplainTelemetry();
    const payload: ExplainStatusResponse = {
      configured: telemetry.configured,
      primaryModel: telemetry.primaryModel,
      fallbackModel: telemetry.fallbackModel,
      primaryModelOk: telemetry.primaryModelOk,
      fallbackModelOk: telemetry.fallbackModelOk,
      modelCheckError: telemetry.modelCheckError,
      lastSuccessAt: telemetry.lastSuccessAt,
      lastError: telemetry.lastError,
      checkedAt: new Date().toISOString(),
    };
    res.status(200).json(payload);
  });

  router.post('/explain', async (req: Request, res: Response) => {
    // Reject oversized bodies (8 KB limit) cleanly with HTTP 400
    const contentLengthHeader = req.headers['content-length'];
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > EXPLAIN_BODY_LIMIT_BYTES) {
        sendError(
          res,
          400,
          'BODY_TOO_LARGE',
          `Request body exceeds ${EXPLAIN_BODY_LIMIT_BYTES} byte limit`,
        );
        return;
      }
    }

    const serializedSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (serializedSize > EXPLAIN_BODY_LIMIT_BYTES) {
      sendError(
        res,
        400,
        'BODY_TOO_LARGE',
        `Request body (${serializedSize} bytes) exceeds ${EXPLAIN_BODY_LIMIT_BYTES} byte limit`,
      );
      return;
    }

    const validation = validateExplainSnapshot(req.body);
    if (!validation.ok) {
      sendError(res, 400, 'INVALID_SNAPSHOT', validation.message);
      return;
    }

    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      sendError(
        res,
        429,
        'RATE_LIMITED',
        `Rate limit exceeded (${EXPLAIN_RATE_LIMIT_MAX_REQUESTS} requests per ${EXPLAIN_RATE_LIMIT_WINDOW_MS / 1000}s). Retry in ${rateCheck.retryAfterSec}s.`,
      );
      return;
    }

    if (!GEMINI_CONFIGURED) {
      const err = new GeminiNotConfiguredError();
      sendError(res, 503, 'GEMINI_NOT_CONFIGURED', err.message);
      return;
    }

    try {
      const { explanation, model, generatedAt, cached } = await explainSnapshot(validation.value);
      const envelope: ExplainApiEnvelope = {
        data: {
          explanation,
          model,
          generatedAt,
        },
        source: 'Gemini (structured output)',
        cached,
      };
      res.status(200).json(envelope);
    } catch (err) {
      if (err instanceof GeminiNotConfiguredError) {
        sendError(res, 503, err.code, err.message);
        return;
      }
      if (err instanceof GeminiApiError) {
        sendError(res, err.status, err.code, err.message, {
          offendingNumbers: err.offendingNumbers,
          matchedWords: err.matchedWords,
        });
        return;
      }
      sendError(
        res,
        502,
        'GEMINI_UPSTREAM_ERROR',
        err instanceof Error ? err.message : 'Failed to generate structured explanation',
      );
    }
  });

  return router;
}
