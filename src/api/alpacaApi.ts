import type {
  AlpacaApiEnvelope,
  AlpacaApiErrorResponse,
  AlpacaBarsResponse,
  AlpacaFeed,
  AlpacaStatusResponse,
  AlpacaTimeframe,
  AlpacaValidateResponse,
} from '../contracts/alpaca';

export class ProxyRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: string;
  readonly timestamp: string;

  constructor(payload: AlpacaApiErrorResponse) {
    super(payload.error);
    this.name = 'ProxyRequestError';
    this.status = payload.status;
    this.code = payload.code;
    this.source = payload.source;
    this.timestamp = payload.timestamp;
  }
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProxyRequestError({
      error: `Invalid JSON from server (${res.status})`,
      code: 'INVALID_JSON',
      status: res.status,
      source: 'Alpaca Market Data Proxy',
      timestamp: new Date().toISOString(),
    });
  }

  if (!res.ok) {
    const errObj = parsed as Partial<AlpacaApiErrorResponse>;
    throw new ProxyRequestError({
      error: errObj.error || `Request failed with HTTP ${res.status}`,
      code: errObj.code || 'HTTP_ERROR',
      status: res.status,
      source: errObj.source || 'Alpaca Market Data Proxy',
      timestamp: errObj.timestamp || new Date().toISOString(),
    });
  }

  return parsed as T;
}

export function fetchAlpacaStatus(signal?: AbortSignal): Promise<AlpacaStatusResponse> {
  return fetchJson<AlpacaStatusResponse>('/api/alpaca/status', signal);
}

export function validateAlpacaSymbol(
  symbol: string,
  signal?: AbortSignal,
): Promise<AlpacaApiEnvelope<AlpacaValidateResponse>> {
  return fetchJson<AlpacaApiEnvelope<AlpacaValidateResponse>>(
    `/api/alpaca/validate/${encodeURIComponent(symbol)}`,
    signal,
  );
}

export function fetchAlpacaBars(
  params: {
    symbol: string;
    timeframe: AlpacaTimeframe;
    start: string;
    end: string;
    feed?: AlpacaFeed;
  },
  signal?: AbortSignal,
): Promise<AlpacaApiEnvelope<AlpacaBarsResponse>> {
  const qs = new URLSearchParams({
    symbol: params.symbol,
    timeframe: params.timeframe,
    start: params.start,
    end: params.end,
  });
  if (params.feed) {
    qs.set('feed', params.feed);
  }
  return fetchJson<AlpacaApiEnvelope<AlpacaBarsResponse>>(
    `/api/alpaca/bars?${qs.toString()}`,
    signal,
  );
}

export function fetchAlpacaLatestQuote(
  symbol: string,
  signal?: AbortSignal,
): Promise<AlpacaApiEnvelope<unknown>> {
  return fetchJson<AlpacaApiEnvelope<unknown>>(
    `/api/alpaca/quote/${encodeURIComponent(symbol)}`,
    signal,
  );
}

export function fetchAlpacaLatestTrade(
  symbol: string,
  signal?: AbortSignal,
): Promise<AlpacaApiEnvelope<unknown>> {
  return fetchJson<AlpacaApiEnvelope<unknown>>(
    `/api/alpaca/trade/${encodeURIComponent(symbol)}`,
    signal,
  );
}
