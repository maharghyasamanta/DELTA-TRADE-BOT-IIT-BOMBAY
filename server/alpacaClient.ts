import type {
  AlpacaBar,
  AlpacaFeed,
  AlpacaTimeframe,
} from '../src/contracts/alpaca.ts';

const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID?.trim() ?? '';
const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY?.trim() ?? '';

export const ALPACA_CONFIGURED = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);

const ALPACA_DATA_BASE = 'https://data.alpaca.markets';

const BARS_TTL_MS = 30_000;
const QUOTE_TTL_MS = 5_000;
const TRADE_TTL_MS = 5_000;
const MAX_RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BAR_PAGES = 50;

const ALLOWED_PATH_PATTERNS: readonly RegExp[] = [
  /^\/v2\/stocks\/[A-Z]{1,10}\/bars(\?.*)?$/,
  /^\/v2\/stocks\/[A-Z]{1,10}\/quotes\/latest(\?.*)?$/,
  /^\/v2\/stocks\/[A-Z]{1,10}\/trades\/latest(\?.*)?$/,
];

interface PrivateCacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

class PrivateTtlCache<T> {
  private readonly store = new Map<string, PrivateCacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 200) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): { value: T; ageMs: number } | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    const now = Date.now();
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value, ageMs: now - entry.storedAt };
  }

  set(key: string, value: T): void {
    const now = Date.now();
    if (this.store.size >= this.maxEntries) {
      for (const [k, existing] of this.store.entries()) {
        if (now >= existing.expiresAt) {
          this.store.delete(k);
        }
      }
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + this.ttlMs,
    });
  }
}

const barsCache = new PrivateTtlCache<AlpacaBar[]>(BARS_TTL_MS, 200);
const quoteCache = new PrivateTtlCache<unknown>(QUOTE_TTL_MS, 200);
const tradeCache = new PrivateTtlCache<unknown>(TRADE_TTL_MS, 200);

const loggedShapes = new Set<string>();

let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export class AlpacaNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'ALPACA_NOT_CONFIGURED';

  constructor(
    message = 'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment',
  ) {
    super(message);
    this.name = 'AlpacaNotConfiguredError';
  }
}

export class AlpacaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly alpacaCode?: number;

  constructor(
    message: string,
    status = 502,
    code = 'ALPACA_UPSTREAM_ERROR',
    alpacaCode?: number,
  ) {
    super(message);
    this.name = 'AlpacaApiError';
    this.status = status;
    this.code = code;
    this.alpacaCode = alpacaCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertAllowedPath(path: string): void {
  const isAllowed = ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(path));
  if (!isAllowed) {
    throw new AlpacaApiError('Disallowed Alpaca Market Data endpoint path', 400, 'DISALLOWED_PATH');
  }
}

function logShapeOnce(label: string, sample: unknown): void {
  if (loggedShapes.has(label) || sample === undefined || sample === null) {
    return;
  }
  loggedShapes.add(label);
  const keys =
    typeof sample === 'object' && !Array.isArray(sample)
      ? Object.keys(sample as Record<string, unknown>)
      : [];
  console.log(`[AlpacaClient] Inspected ${label} keys:`, keys);
}

export function parseAlpacaErrorBody(
  rawText: string,
  status?: number,
): { message?: string; alpacaCode?: number } {
  if (!rawText) return {};
  try {
    const parsed = JSON.parse(rawText) as { message?: unknown; error?: unknown; code?: unknown };
    const message =
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : undefined;
    const alpacaCode = typeof parsed.code === 'number' ? parsed.code : undefined;
    return { message, alpacaCode };
  } catch {
    const trimmed = rawText.trim();
    if (/<(?:!doctype|html|head|body|title|h1)\b/i.test(trimmed)) {
      const titleMatch = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i);
      const h1Match = trimmed.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      const stripped = (titleMatch?.[1] || h1Match?.[1] || trimmed.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      if (status === 401) {
        return {
          message: `${stripped || 'HTTP 401 Unauthorized'} — verify ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are valid and active.`,
        };
      }
      if (status === 403) {
        return {
          message: `${stripped || 'HTTP 403 Forbidden'} — check Alpaca API key permissions.`,
        };
      }
      return { message: stripped.slice(0, 200) || undefined };
    }
    return { message: trimmed.slice(0, 240) };
  }
}

async function fetchAlpacaJson<T>(path: string, shapePrefix: string): Promise<T> {
  if (!ALPACA_CONFIGURED) {
    const err = new AlpacaNotConfiguredError();
    lastError = err.message;
    throw err;
  }

  assertAllowedPath(path);

  const url = `${ALPACA_DATA_BASE}${path}`;
  let lastCaught: unknown;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'APCA-API-KEY-ID': ALPACA_API_KEY_ID,
          'APCA-API-SECRET-KEY': ALPACA_API_SECRET_KEY,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const baseBackoffMs = 1000 * Math.pow(2, attempt - 1);
        const waitMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 60_000)
            : baseBackoffMs;

        if (attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(waitMs);
          continue;
        }

        const bodyText = await response.text().catch(() => '');
        const { message, alpacaCode } = parseAlpacaErrorBody(bodyText, response.status);
        throw new AlpacaApiError(
          message || `Alpaca Market Data rate limit reached (HTTP 429)`,
          429,
          'ALPACA_RATE_LIMITED',
          alpacaCode,
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const { message, alpacaCode } = parseAlpacaErrorBody(bodyText, response.status);

        if (response.status >= 500 && attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(1000 * Math.pow(2, attempt - 1));
          continue;
        }

        const isPlanRestriction =
          alpacaCode === 42210000 ||
          (response.status === 403 &&
            typeof message === 'string' &&
            /subscription does not permit|sip/i.test(message));
        const mappedCode = isPlanRestriction ? 'PLAN_RESTRICTION' : 'ALPACA_HTTP_ERROR';
        throw new AlpacaApiError(
          message || `Alpaca Market Data returned HTTP ${response.status}`,
          response.status,
          mappedCode,
          alpacaCode,
        );
      }

      const json = (await response.json()) as T;
      logShapeOnce(shapePrefix, json);

      lastSuccessAt = new Date().toISOString();
      lastError = null;
      return json;
    } catch (err) {
      lastCaught = err;
      if (err instanceof AlpacaNotConfiguredError) {
        throw err;
      }
      if (err instanceof AlpacaApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        break;
      }
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(1000 * Math.pow(2, attempt - 1));
      }
    }
  }

  const message =
    lastCaught instanceof Error ? lastCaught.message : 'Unknown error contacting Alpaca Market Data';
  lastError = message;

  if (lastCaught instanceof AlpacaApiError) {
    throw lastCaught;
  }
  throw new AlpacaApiError(message, 502, 'ALPACA_NETWORK_ERROR');
}

interface RawAlpacaBarsPayload {
  bars?: AlpacaBar[] | null;
  symbol?: string;
  next_page_token?: string | null;
}

export async function fetchAlpacaBarsWithMeta(
  symbol: string,
  timeframe: AlpacaTimeframe,
  start: string,
  end: string,
  feed?: AlpacaFeed,
): Promise<{ bars: AlpacaBar[]; cached: boolean; fetchedAt: string }> {
  const cacheKey = `bars:${symbol}:${timeframe}:${start}:${end}:${feed ?? 'default'}`;
  const cached = barsCache.get(cacheKey);
  if (cached) {
    return {
      bars: cached.value,
      cached: true,
      fetchedAt: new Date(Date.now() - cached.ageMs).toISOString(),
    };
  }

  const allBars: AlpacaBar[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_BAR_PAGES; page++) {
    const params = new URLSearchParams({
      timeframe,
      start,
      end,
      limit: '1000',
    });
    if (feed) {
      params.set('feed', feed);
    }
    if (pageToken) {
      params.set('page_token', pageToken);
    }

    const path = `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;
    const payload = await fetchAlpacaJson<RawAlpacaBarsPayload>(path, 'GET /v2/stocks/:symbol/bars');

    const batch = Array.isArray(payload.bars) ? payload.bars : [];
    if (page === 0 && batch.length > 0) {
      logShapeOnce('GET /v2/stocks/:symbol/bars[0]', batch[0]);
    }
    allBars.push(...batch);

    if (typeof payload.next_page_token === 'string' && payload.next_page_token.length > 0) {
      pageToken = payload.next_page_token;
    } else {
      break;
    }
  }

  barsCache.set(cacheKey, allBars);
  return {
    bars: allBars,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAlpacaBars(
  symbol: string,
  timeframe: AlpacaTimeframe,
  start: string,
  end: string,
  feed?: AlpacaFeed,
): Promise<AlpacaBar[]> {
  const { bars } = await fetchAlpacaBarsWithMeta(symbol, timeframe, start, end, feed);
  return bars;
}

export async function fetchAlpacaLatestQuoteWithMeta(
  symbol: string,
): Promise<{ quote: unknown; cached: boolean; fetchedAt: string }> {
  const cacheKey = `quote:${symbol}`;
  const cached = quoteCache.get(cacheKey);
  if (cached) {
    return {
      quote: cached.value,
      cached: true,
      fetchedAt: new Date(Date.now() - cached.ageMs).toISOString(),
    };
  }

  const path = `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
  const quote = await fetchAlpacaJson<unknown>(path, 'GET /v2/stocks/:symbol/quotes/latest');
  quoteCache.set(cacheKey, quote);
  return {
    quote,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAlpacaLatestQuote(symbol: string): Promise<unknown> {
  const { quote } = await fetchAlpacaLatestQuoteWithMeta(symbol);
  return quote;
}

export async function fetchAlpacaLatestTradeWithMeta(
  symbol: string,
): Promise<{ trade: unknown; cached: boolean; fetchedAt: string }> {
  const cacheKey = `trade:${symbol}`;
  const cached = tradeCache.get(cacheKey);
  if (cached) {
    return {
      trade: cached.value,
      cached: true,
      fetchedAt: new Date(Date.now() - cached.ageMs).toISOString(),
    };
  }

  const path = `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`;
  const trade = await fetchAlpacaJson<unknown>(path, 'GET /v2/stocks/:symbol/trades/latest');
  tradeCache.set(cacheKey, trade);
  return {
    trade,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAlpacaLatestTrade(symbol: string): Promise<unknown> {
  const { trade } = await fetchAlpacaLatestTradeWithMeta(symbol);
  return trade;
}

export function getAlpacaTelemetry(): {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
} {
  return {
    configured: ALPACA_CONFIGURED,
    lastSuccessAt,
    lastError,
  };
}
