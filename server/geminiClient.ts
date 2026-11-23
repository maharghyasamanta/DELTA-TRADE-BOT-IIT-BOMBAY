import { createHash } from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  EXPLAIN_SYSTEM_INSTRUCTION,
  type ExplainKeyPoint,
  type ExplainSnapshotRequest,
  type ExplainStructuredOutput,
} from '../src/contracts/explain.ts';
import { validateExplainOutput } from '../src/engine/explainGuard.ts';

export { EXPLAIN_SYSTEM_INSTRUCTION };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() ?? '';
export const GEMINI_CONFIGURED = Boolean(GEMINI_API_KEY);

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-4-hydrogen';
export const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-3.1-flash-lite';
export const EXPLAIN_CACHE_TTL_MS = 60_000;
export const EXPLAIN_TIMEOUT_MS = 12_000;
export const EXPLAIN_MAX_ATTEMPTS = 2; // retry only 429 and 5xx/network
export const EXPLAIN_TOTAL_BUDGET_MS = 24_000;
export const EXPLAIN_MAX_RETRY_DELAY_MS = 8_000;
const MODEL_CHECK_TTL_MS = 5 * 60_000;
const EXPLAIN_CACHE_MAX_ENTRIES = 100;

interface CacheEntry {
  explanation: ExplainStructuredOutput;
  model: string;
  generatedAt: string;
  expiresAt: number;
}

class PrivateExplainCache {
  private readonly store = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, value: Omit<CacheEntry, 'expiresAt'>): void {
    const now = Date.now();
    if (this.store.size >= EXPLAIN_CACHE_MAX_ENTRIES) {
      for (const [k, existing] of this.store.entries()) {
        if (now >= existing.expiresAt) {
          this.store.delete(k);
        }
      }
      if (this.store.size >= EXPLAIN_CACHE_MAX_ENTRIES) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) {
          this.store.delete(oldest);
        }
      }
    }
    this.store.set(key, {
      ...value,
      expiresAt: now + EXPLAIN_CACHE_TTL_MS,
    });
  }
}

const explainCache = new PrivateExplainCache();
const inFlightExplain = new Map<
  string,
  Promise<{
    explanation: ExplainStructuredOutput;
    model: string;
    generatedAt: string;
    cached: boolean;
  }>
>();

let aiClient: GoogleGenAI | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

interface ModelVerificationState {
  primaryModelOk: boolean | null;
  fallbackModelOk: boolean | null;
  modelCheckError: string | null;
  checkedAtMs: number;
}

let modelVerification: ModelVerificationState = {
  primaryModelOk: null,
  fallbackModelOk: null,
  modelCheckError: null,
  checkedAtMs: 0,
};
let inFlightModelCheck: Promise<void> | null = null;

function getAiClient(): GoogleGenAI {
  if (!GEMINI_CONFIGURED) {
    throw new GeminiNotConfiguredError();
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

export class GeminiNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'GEMINI_NOT_CONFIGURED';

  constructor(
    message = 'Gemini not configured — set GEMINI_API_KEY in your server environment',
  ) {
    super(message);
    this.name = 'GeminiNotConfiguredError';
  }
}

export class GeminiApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly offendingNumbers?: number[];
  readonly matchedWords?: string[];

  constructor(
    message: string,
    status = 502,
    code = 'GEMINI_UPSTREAM_ERROR',
    offendingNumbers?: number[],
    matchedWords?: string[],
  ) {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.code = code;
    this.offendingNumbers = offendingNumbers;
    this.matchedWords = matchedWords;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashSnapshot(snapshot: ExplainSnapshotRequest): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function clampSummary(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 400) return trimmed;
  const slice = trimmed.slice(0, 397);
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > 200 ? slice.slice(0, lastSpace) : slice).trimEnd()}...`;
}

function parseStructuredExplanation(rawText: string): ExplainStructuredOutput {
  const cleanedText = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    throw new GeminiApiError(
      'Gemini returned non-JSON output for structured explanation',
      502,
      'GEMINI_INVALID_JSON',
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GeminiApiError(
      'Gemini structured output was not a JSON object',
      502,
      'GEMINI_INVALID_SCHEMA',
    );
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    throw new GeminiApiError(
      'Gemini structured output missing summary string',
      502,
      'GEMINI_INVALID_SCHEMA',
    );
  }

  if (
    !Array.isArray(record.keyPoints) ||
    !Array.isArray(record.cautions) ||
    !Array.isArray(record.unavailable)
  ) {
    throw new GeminiApiError(
      'Gemini structured output missing required arrays',
      502,
      'GEMINI_INVALID_SCHEMA',
    );
  }

  const keyPoints: ExplainKeyPoint[] = [];
  for (const item of record.keyPoints.slice(0, 6)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new GeminiApiError(
        'Gemini structured output contained an invalid keyPoint item',
        502,
        'GEMINI_INVALID_SCHEMA',
      );
    }
    const kp = item as Record<string, unknown>;
    if (
      typeof kp.label !== 'string' ||
      typeof kp.valueText !== 'string' ||
      typeof kp.meaning !== 'string'
    ) {
      throw new GeminiApiError(
        'Gemini structured output keyPoint missing label/valueText/meaning strings',
        502,
        'GEMINI_INVALID_SCHEMA',
      );
    }
    keyPoints.push({
      label: kp.label.trim(),
      valueText: kp.valueText.trim(),
      meaning: kp.meaning.trim(),
    });
  }

  const cautions: string[] = record.cautions
    .slice(0, 3)
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());

  const unavailable: string[] = record.unavailable
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());

  return {
    summary: clampSummary(record.summary),
    keyPoints,
    cautions,
    unavailable,
  };
}

export interface GeminiExtractedError {
  status: number;
  message: string;
  retryAfterMs: number | null;
  retryable: boolean;
  isAuthError: boolean;
  code: string;
}

export function extractGeminiErrorDetails(err: unknown): GeminiExtractedError {
  if (err instanceof GeminiNotConfiguredError) {
    return {
      status: err.status,
      message: err.message,
      retryAfterMs: null,
      retryable: false,
      isAuthError: false,
      code: err.code,
    };
  }
  if (err instanceof GeminiApiError) {
    return {
      status: err.status,
      message: err.message,
      retryAfterMs: null,
      retryable: false,
      isAuthError: err.code === 'GEMINI_AUTH_ERROR',
      code: err.code,
    };
  }

  const obj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
  const rawStatus =
    obj && typeof obj.status === 'number' && Number.isFinite(obj.status)
      ? obj.status
      : undefined;

  let rawMessage = err instanceof Error ? err.message : 'Unknown error calling Gemini API';
  if (rawMessage.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawMessage) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
        rawMessage = parsed.error.message.trim();
      } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
        rawMessage = parsed.message.trim();
      }
    } catch {
      // Keep rawMessage as-is
    }
  }

  let retryAfterMs: number | null = null;
  if (obj && typeof obj.headers === 'object' && obj.headers !== null) {
    const headersObj = obj.headers as {
      get?: (name: string) => string | null;
      ['retry-after']?: unknown;
    };
    const retryHeader =
      typeof headersObj.get === 'function'
        ? headersObj.get('retry-after')
        : typeof headersObj['retry-after'] === 'string'
          ? headersObj['retry-after']
          : null;
    if (retryHeader) {
      const secs = Number(retryHeader);
      if (Number.isFinite(secs) && secs > 0) {
        retryAfterMs = Math.min(secs * 1000, EXPLAIN_MAX_RETRY_DELAY_MS);
      }
    }
  }

  const isTimeout =
    err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  if (isTimeout) {
    return {
      status: 504,
      message: `Gemini API request timed out after ${EXPLAIN_TIMEOUT_MS / 1000}s`,
      retryAfterMs: null,
      retryable: true,
      isAuthError: false,
      code: 'GEMINI_TIMEOUT',
    };
  }

  if (rawStatus === 401 || rawStatus === 403) {
    return {
      status: 502,
      message: `Gemini API key rejected (HTTP ${rawStatus}) — check GEMINI_API_KEY configuration: ${rawMessage}`,
      retryAfterMs: null,
      retryable: false,
      isAuthError: true,
      code: 'GEMINI_AUTH_ERROR',
    };
  }

  if (rawStatus === 429) {
    return {
      status: 429,
      message: rawMessage || 'Gemini API rate limit / quota reached (HTTP 429)',
      retryAfterMs: retryAfterMs ?? 2_000,
      retryable: true,
      isAuthError: false,
      code: 'GEMINI_RATE_LIMITED',
    };
  }

  if (rawStatus !== undefined) {
    const isModelNotFound =
      rawStatus === 404 || (rawStatus === 400 && /not found|unsupported|model/i.test(rawMessage));
    return {
      status: rawStatus >= 500 ? rawStatus : 502,
      message: rawMessage || `Gemini API returned HTTP ${rawStatus}`,
      retryAfterMs: null,
      retryable: rawStatus >= 500,
      isAuthError: false,
      code: isModelNotFound ? 'GEMINI_MODEL_NOT_FOUND' : rawStatus >= 500 ? 'GEMINI_UPSTREAM_5XX' : 'GEMINI_HTTP_ERROR',
    };
  }

  return {
    status: 502,
    message: rawMessage,
    retryAfterMs: null,
    retryable: true,
    isAuthError: false,
    code: 'GEMINI_NETWORK_ERROR',
  };
}

function isRetryableGuardOrFormatError(err: unknown): err is GeminiApiError {
  return (
    err instanceof GeminiApiError &&
    (err.code === 'UNGROUNDED_OUTPUT' ||
      err.code === 'DISALLOWED_CONTENT' ||
      err.code === 'GEMINI_INVALID_JSON' ||
      err.code === 'GEMINI_INVALID_SCHEMA' ||
      err.code === 'GEMINI_EMPTY_RESPONSE')
  );
}

export function buildCorrectiveInstruction(err: GeminiApiError): string {
  if (err.code === 'DISALLOWED_CONTENT' && err.matchedWords && err.matchedWords.length > 0) {
    return `CORRECTION REQUIRED: Your previous output violated safety rules because it contained disallowed word(s): ${err.matchedWords.join(', ')}. Remove those words completely (for example use "trailing" instead of "short", "so that" instead of "in order to") and output valid JSON again.`;
  }
  if (err.code === 'UNGROUNDED_OUTPUT' && err.offendingNumbers && err.offendingNumbers.length > 0) {
    return `CORRECTION REQUIRED: Your previous output contained ungrounded numbers not present in the input JSON: ${err.offendingNumbers.join(', ')}. Remove all computed/extrapolated numbers and use ONLY exact or rounded numbers present in the input JSON.`;
  }
  return 'CORRECTION REQUIRED: Return strictly valid JSON matching the exact schema with summary, keyPoints, cautions, and unavailable, using ONLY numbers from the input JSON.';
}

async function runModelVerification(): Promise<void> {
  if (!GEMINI_CONFIGURED) {
    modelVerification = {
      primaryModelOk: null,
      fallbackModelOk: null,
      modelCheckError: null,
      checkedAtMs: Date.now(),
    };
    return;
  }

  const ai = getAiClient();
  const availableNames = new Set<string>();

  try {
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const modelInfo of pager) {
      if (typeof modelInfo.name === 'string') {
        const stripped = modelInfo.name.replace(/^models\//, '');
        availableNames.add(stripped);
      }
    }

    let primaryOk = availableNames.has(GEMINI_MODEL);
    let fallbackOk = availableNames.has(GEMINI_FALLBACK_MODEL);

    // Fallback to direct get() if list did not include them (e.g. truncated or gated alias)
    if (!primaryOk) {
      try {
        await ai.models.get({ model: GEMINI_MODEL });
        primaryOk = true;
      } catch {
        primaryOk = false;
      }
    }
    if (!fallbackOk) {
      try {
        await ai.models.get({ model: GEMINI_FALLBACK_MODEL });
        fallbackOk = true;
      } catch {
        fallbackOk = false;
      }
    }

    const errors: string[] = [];
    if (!primaryOk) {
      errors.push(`Primary model "${GEMINI_MODEL}" not found`);
    }
    if (!fallbackOk) {
      errors.push(`Fallback model "${GEMINI_FALLBACK_MODEL}" not found`);
    }

    modelVerification = {
      primaryModelOk: primaryOk,
      fallbackModelOk: fallbackOk,
      modelCheckError: errors.length > 0 ? errors.join('; ') : null,
      checkedAtMs: Date.now(),
    };
  } catch (err) {
    const details = extractGeminiErrorDetails(err);
    modelVerification = {
      primaryModelOk: false,
      fallbackModelOk: false,
      modelCheckError: details.message,
      checkedAtMs: Date.now(),
    };
  }
}

export async function verifyGeminiModelsIfNeeded(force = false): Promise<void> {
  if (!GEMINI_CONFIGURED) return;
  const isFresh =
    !force &&
    modelVerification.checkedAtMs > 0 &&
    Date.now() - modelVerification.checkedAtMs < MODEL_CHECK_TTL_MS;
  if (isFresh) return;

  if (!inFlightModelCheck) {
    inFlightModelCheck = runModelVerification().finally(() => {
      inFlightModelCheck = null;
    });
  }
  await inFlightModelCheck;
}

// Kick off non-blocking startup model check when configured
if (GEMINI_CONFIGURED) {
  void verifyGeminiModelsIfNeeded(true);
}

async function generateStructuredOnce(
  ai: GoogleGenAI,
  activeModel: string,
  snapshot: ExplainSnapshotRequest,
  correctionPrompt?: string,
  timeoutMs = EXPLAIN_TIMEOUT_MS,
): Promise<ExplainStructuredOutput> {
  const supportsThinkingLevel =
    activeModel.startsWith('gemini-3') || activeModel.startsWith('gemini-4');

  const userContents = correctionPrompt
    ? `${JSON.stringify(snapshot)}\n\n${correctionPrompt}`
    : JSON.stringify(snapshot);

  const response = await ai.models.generateContent({
    model: activeModel,
    contents: userContents,
    config: {
      systemInstruction: EXPLAIN_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      ...(supportsThinkingLevel ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
      abortSignal: AbortSignal.timeout(timeoutMs),
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description:
              'Concise plain-language summary (max 400 characters) using ONLY numbers present in the input JSON.',
          },
          keyPoints: {
            type: Type.ARRAY,
            description: 'Up to 6 structured metric explanations grounded in the input JSON.',
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING, description: 'Metric or rule name.' },
                valueText: {
                  type: Type.STRING,
                  description: 'Observed input value formatted cleanly (or "unavailable").',
                },
                meaning: {
                  type: Type.STRING,
                  description: 'What this observed value describes without recommending actions.',
                },
              },
              required: ['label', 'valueText', 'meaning'],
            },
          },
          cautions: {
            type: Type.ARRAY,
            description: 'Up to 3 descriptive data or threshold cautions (max 3 items).',
            items: { type: Type.STRING },
          },
          unavailable: {
            type: Type.ARRAY,
            description:
              'List any null/missing metrics explicitly noted as unavailable; empty array if all metrics exist.',
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'keyPoints', 'cautions', 'unavailable'],
      },
    },
  });

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new GeminiApiError(
      'Gemini returned an empty structured explanation response',
      502,
      'GEMINI_EMPTY_RESPONSE',
    );
  }

  const explanation = parseStructuredExplanation(rawText);
  const guard = validateExplainOutput(explanation, snapshot);
  if (!guard.ok) {
    throw new GeminiApiError(
      guard.message,
      502,
      guard.code,
      guard.offendingNumbers,
      guard.matchedWords,
    );
  }

  return explanation;
}

export async function explainSnapshot(snapshot: ExplainSnapshotRequest): Promise<{
  explanation: ExplainStructuredOutput;
  model: string;
  generatedAt: string;
  cached: boolean;
}> {
  if (!GEMINI_CONFIGURED) {
    const err = new GeminiNotConfiguredError();
    lastError = err.message;
    throw err;
  }

  const cacheKey = hashSnapshot(snapshot);
  const cachedEntry = explainCache.get(cacheKey);
  if (cachedEntry) {
    return {
      explanation: cachedEntry.explanation,
      model: cachedEntry.model,
      generatedAt: cachedEntry.generatedAt,
      cached: true,
    };
  }

  const existingFlight = inFlightExplain.get(cacheKey);
  if (existingFlight) {
    return existingFlight;
  }

  const runPromise = (async () => {
    const ai = getAiClient();
    const overallStartedAt = Date.now();
    const modelsToTry =
      GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL
        ? [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]
        : [GEMINI_MODEL];

    let lastCaughtDetails: GeminiExtractedError | null = null;
    let lastGuardError: GeminiApiError | null = null;
    const attemptSummaries: Array<{ model: string; status: number; code: string; message: string }> =
      [];

    for (const activeModel of modelsToTry) {
      let correctionPrompt: string | undefined;
      let usedCorrectiveRetry = false;

      for (let attempt = 1; attempt <= EXPLAIN_MAX_ATTEMPTS; attempt += 1) {
        const remainingBudgetMs = EXPLAIN_TOTAL_BUDGET_MS - (Date.now() - overallStartedAt);
        if (remainingBudgetMs < 1_500) {
          break;
        }
        const callTimeoutMs = Math.min(EXPLAIN_TIMEOUT_MS, remainingBudgetMs);
        const attemptStart = Date.now();

        try {
          const explanation = await generateStructuredOnce(
            ai,
            activeModel,
            snapshot,
            correctionPrompt,
            callTimeoutMs,
          );

          const generatedAt = new Date().toISOString();
          explainCache.set(cacheKey, {
            explanation,
            model: activeModel,
            generatedAt,
          });

          lastSuccessAt = generatedAt;
          lastError = null;

          return {
            explanation,
            model: activeModel,
            generatedAt,
            cached: false,
          };
        } catch (err) {
          if (err instanceof GeminiNotConfiguredError) {
            throw err;
          }

          if (isRetryableGuardOrFormatError(err)) {
            lastGuardError = err;
            lastCaughtDetails = extractGeminiErrorDetails(err);
            attemptSummaries.push({
              model: activeModel,
              status: err.status,
              code: err.code,
              message: err.message,
            });
            console.warn(
              `[GeminiClient] model=${activeModel} guard/format failure code=${err.code} message=${err.message}`,
            );

            // Allow one corrective retry on the same model before falling through to fallback model
            if (!usedCorrectiveRetry && Date.now() - overallStartedAt < EXPLAIN_TOTAL_BUDGET_MS - 2_000) {
              usedCorrectiveRetry = true;
              correctionPrompt = buildCorrectiveInstruction(err);
              attempt = Math.max(attempt - 1, 0); // Do not burn the transient retry budget on a 1x guard correction
              continue;
            }
            break; // Proceed to fallback model
          }

          const details = extractGeminiErrorDetails(err);
          lastCaughtDetails = details;
          lastGuardError = null;
          const elapsedMs = Date.now() - attemptStart;
          attemptSummaries.push({
            model: activeModel,
            status: details.status,
            code: details.code,
            message: details.message,
          });
          console.warn(
            `[GeminiClient] model=${activeModel} attempt=${attempt} elapsedMs=${elapsedMs} status=${details.status} code=${details.code} message=${details.message}`,
          );

          // Invalid key / auth rejection should fail immediately without trying fallback
          if (details.isAuthError) {
            lastError = details.message;
            throw new GeminiApiError(details.message, 502, details.code);
          }

          // Non-retryable upstream errors (404 model not found, 400, etc.) break inner loop and try fallback model
          if (!details.retryable) {
            break;
          }

          if (attempt < EXPLAIN_MAX_ATTEMPTS) {
            const baseWait = details.retryAfterMs ?? 700 * Math.pow(2, attempt - 1);
            const jitter = Math.floor(Math.random() * 250);
            const waitMs = Math.min(baseWait + jitter, EXPLAIN_MAX_RETRY_DELAY_MS);
            const remainingAfterWait = EXPLAIN_TOTAL_BUDGET_MS - (Date.now() - overallStartedAt) - waitMs;
            if (remainingAfterWait < 2_000) {
              break;
            }
            await sleep(waitMs);
          }
        }
      }
    }

    if (lastGuardError && lastCaughtDetails?.code === lastGuardError.code) {
      lastError = lastGuardError.message;
      throw lastGuardError;
    }

    let finalMessage = lastCaughtDetails?.message ?? 'Unknown error calling Gemini API';
    if (attemptSummaries.length > 1) {
      const modelSummary = attemptSummaries
        .map((item) => `${item.model} (${item.code})`)
        .join(', ');
      finalMessage = `Tried ${modelSummary}: ${lastCaughtDetails?.message ?? 'upstream request failed'}`;
    } else if (attemptSummaries.length === 1) {
      finalMessage = `${attemptSummaries[0].model} (HTTP ${attemptSummaries[0].status}): ${attemptSummaries[0].message}`;
    }

    lastError = finalMessage;
    throw new GeminiApiError(
      finalMessage,
      lastCaughtDetails?.status ?? 502,
      lastCaughtDetails?.code ?? 'GEMINI_UPSTREAM_ERROR',
      lastGuardError?.offendingNumbers,
      lastGuardError?.matchedWords,
    );
  })().finally(() => {
    inFlightExplain.delete(cacheKey);
  });

  inFlightExplain.set(cacheKey, runPromise);
  return runPromise;
}

export function getExplainTelemetry(): {
  configured: boolean;
  primaryModel: string;
  fallbackModel: string;
  primaryModelOk: boolean | null;
  fallbackModelOk: boolean | null;
  modelCheckError: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
} {
  return {
    configured: GEMINI_CONFIGURED,
    primaryModel: GEMINI_MODEL,
    fallbackModel: GEMINI_FALLBACK_MODEL,
    primaryModelOk: modelVerification.primaryModelOk,
    fallbackModelOk: modelVerification.fallbackModelOk,
    modelCheckError: modelVerification.modelCheckError,
    lastSuccessAt,
    lastError,
  };
}
