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

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';
export const EXPLAIN_CACHE_TTL_MS = 60_000;
export const EXPLAIN_TIMEOUT_MS = 15_000;
export const EXPLAIN_MAX_ATTEMPTS = 1;
export const EXPLAIN_MAX_RETRY_DELAY_MS = 60_000;
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

let aiClient: GoogleGenAI | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

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

  if (!Array.isArray(record.keyPoints) || !Array.isArray(record.cautions) || !Array.isArray(record.unavailable)) {
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

function extractErrorDetails(err: unknown): {
  status: number;
  message: string;
  retryAfterMs: number | null;
  retryable: boolean;
  code: string;
} {
  if (err instanceof GeminiApiError || err instanceof GeminiNotConfiguredError) {
    return {
      status: err.status,
      message: err.message,
      retryAfterMs: null,
      retryable: false,
      code: err.code,
    };
  }

  const obj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
  const rawStatus = obj && typeof obj.status === 'number' && Number.isFinite(obj.status)
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
      // Keep rawMessage as-is if not valid JSON
    }
  }

  // Extract retry delay from response headers if attached, or error message retry info
  let retryAfterMs: number | null = null;
  if (obj && typeof obj.headers === 'object' && obj.headers !== null) {
    const headersObj = obj.headers as { get?: (name: string) => string | null; ['retry-after']?: unknown };
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
      code: 'GEMINI_TIMEOUT',
    };
  }

  if (rawStatus === 429) {
    return {
      status: 429,
      message: rawMessage || 'Gemini API rate limit / quota reached (HTTP 429)',
      retryAfterMs: retryAfterMs ?? 2_000,
      retryable: true,
      code: 'GEMINI_RATE_LIMITED',
    };
  }

  if (rawStatus !== undefined) {
    return {
      status: rawStatus,
      message: rawMessage || `Gemini API returned HTTP ${rawStatus}`,
      retryAfterMs: null,
      retryable: rawStatus >= 500,
      code: rawStatus >= 500 ? 'GEMINI_UPSTREAM_5XX' : 'GEMINI_HTTP_ERROR',
    };
  }

  return {
    status: 502,
    message: rawMessage,
    retryAfterMs: null,
    retryable: true,
    code: 'GEMINI_NETWORK_ERROR',
  };
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

  const ai = getAiClient();
  let lastCaught: ReturnType<typeof extractErrorDetails> | null = null;
  const attemptSummaries: Array<{ model: string; status: number; code: string; message: string }> = [];
  const modelsToTry = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL] as const;

  for (const activeModel of modelsToTry) {
    const thinkingLevel =
      activeModel === GEMINI_FALLBACK_MODEL ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;

    for (let attempt = 1; attempt <= EXPLAIN_MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await ai.models.generateContent({
          model: activeModel,
          contents: JSON.stringify(snapshot),
          config: {
            systemInstruction: EXPLAIN_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel },
            abortSignal: AbortSignal.timeout(EXPLAIN_TIMEOUT_MS),
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

        // Server-side deterministic guard check BEFORE caching or returning
        const guard = validateExplainOutput(explanation, snapshot);
        if (!guard.ok) {
          const guardErr = new GeminiApiError(
            guard.message,
            502,
            guard.code,
            guard.offendingNumbers,
            guard.matchedWords,
          );
          lastError = guardErr.message;
          throw guardErr;
        }

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
        if (
          err instanceof GeminiApiError &&
          (err.code === 'UNGROUNDED_OUTPUT' ||
            err.code === 'DISALLOWED_CONTENT' ||
            err.code === 'GEMINI_INVALID_JSON' ||
            err.code === 'GEMINI_INVALID_SCHEMA')
        ) {
          throw err;
        }

        const details = extractErrorDetails(err);
        lastCaught = details;
        const elapsedMs = Date.now() - startedAt;
        attemptSummaries.push({
          model: activeModel,
          status: details.status,
          code: details.code,
          message: details.message,
        });
        console.warn(
          `[GeminiClient] model=${activeModel} attempt=${attempt} elapsedMs=${elapsedMs} status=${details.status} code=${details.code} message=${details.message}`,
        );

        if (!details.retryable) {
          lastError = details.message;
          throw new GeminiApiError(details.message, details.status, details.code);
        }

        if (attempt < EXPLAIN_MAX_ATTEMPTS) {
          const waitMs = Math.min(
            details.retryAfterMs ?? 600 * Math.pow(2, attempt - 1),
            EXPLAIN_MAX_RETRY_DELAY_MS,
          );
          await sleep(waitMs);
        }
      }
    }
  }

  let finalMessage = lastCaught?.message ?? 'Unknown error calling Gemini API';
  if (attemptSummaries.length > 1) {
    const modelSummary = attemptSummaries
      .map((item) => `${item.model} (HTTP ${item.status})`)
      .join(', ');
    finalMessage = `Tried ${modelSummary}: ${lastCaught?.message ?? 'upstream request failed'}`;
  } else if (attemptSummaries.length === 1) {
    finalMessage = `${attemptSummaries[0].model} (HTTP ${attemptSummaries[0].status}): ${attemptSummaries[0].message}`;
  }
  lastError = finalMessage;
  throw new GeminiApiError(
    finalMessage,
    lastCaught?.status ?? 502,
    lastCaught?.code ?? 'GEMINI_UPSTREAM_ERROR',
  );
}

export function getExplainTelemetry(): {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
} {
  return {
    configured: GEMINI_CONFIGURED,
    lastSuccessAt,
    lastError,
  };
}
