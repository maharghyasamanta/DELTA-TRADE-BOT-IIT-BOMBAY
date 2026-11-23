import type {
  ApiEnvelope,
  ApiErrorResponse,
  CandlePriceBasis,
  CandleResolution,
  DeltaCandlesPayload,
  DeltaProductsPayload,
  DeltaStreamEvent,
  DeltaTickerSnapshot,
  HealthStatusResponse,
} from '../contracts/delta';

export class ProxyRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: string;
  readonly timestamp: string;

  constructor(payload: ApiErrorResponse) {
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
      source: 'Regime Sentinel Server Proxy',
      timestamp: new Date().toISOString(),
    });
  }

  if (!res.ok) {
    const errObj = parsed as Partial<ApiErrorResponse>;
    throw new ProxyRequestError({
      error: errObj.error || `Request failed with HTTP ${res.status}`,
      code: errObj.code || 'HTTP_ERROR',
      status: res.status,
      source: errObj.source || 'Regime Sentinel Server Proxy',
      timestamp: errObj.timestamp || new Date().toISOString(),
    });
  }

  return parsed as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthStatusResponse> {
  return fetch(('/api/health'), { headers: { Accept: 'application/json' }, signal }).then(
    async (res) => {
      const data = (await res.json()) as HealthStatusResponse;
      return data;
    },
  );
}

export function fetchProducts(signal?: AbortSignal): Promise<ApiEnvelope<DeltaProductsPayload>> {
  return fetchJson<ApiEnvelope<DeltaProductsPayload>>('/api/delta/products', signal);
}

export function fetchTicker(
  symbol: string,
  signal?: AbortSignal,
): Promise<ApiEnvelope<DeltaTickerSnapshot>> {
  return fetchJson<ApiEnvelope<DeltaTickerSnapshot>>(
    `/api/delta/ticker/${encodeURIComponent(symbol)}`,
    signal,
  );
}

export function fetchCandles(
  params: {
    symbol: string;
    resolution: CandleResolution;
    start: number;
    end: number;
    basis: CandlePriceBasis;
  },
  signal?: AbortSignal,
): Promise<ApiEnvelope<DeltaCandlesPayload>> {
  const qs = new URLSearchParams({
    symbol: params.symbol,
    resolution: params.resolution,
    start: String(params.start),
    end: String(params.end),
    basis: params.basis,
  });
  return fetchJson<ApiEnvelope<DeltaCandlesPayload>>(`/api/delta/candles?${qs.toString()}`, signal);
}

export function subscribeDeltaStream(params: {
  symbol: string;
  resolution: CandleResolution;
  basis: CandlePriceBasis;
  onEvent: (event: DeltaStreamEvent) => void;
  onTransportError: (message: string) => void;
}): () => void {
  const qs = new URLSearchParams({
    symbol: params.symbol,
    resolution: params.resolution,
    basis: params.basis,
  });
  const es = new EventSource(`/api/delta/stream?${qs.toString()}`);

  es.onmessage = (evt) => {
    try {
      const parsed = JSON.parse(evt.data) as DeltaStreamEvent;
      params.onEvent(parsed);
    } catch {
      // Ignore malformed SSE event
    }
  };

  es.onerror = () => {
    params.onTransportError('Live SSE connection interrupted — attempting automatic reconnect');
  };

  return () => {
    es.close();
  };
}
