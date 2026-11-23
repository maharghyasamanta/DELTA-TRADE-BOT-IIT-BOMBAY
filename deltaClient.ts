import { TtlCache } from './cache.ts';
import type {
  CandlePriceBasis,
  CandleResolution,
  DeltaCandle,
  DeltaCandlesPayload,
  DeltaOptionGreeks,
  DeltaProductSummary,
  DeltaProductsPayload,
  DeltaTickerSnapshot,
} from '../src/contracts/delta.ts';

export const DELTA_REST_BASE = 'https://api.india.delta.exchange';

const PRODUCTS_TTL_MS = 60_000;
const CANDLES_TTL_MS = 20_000;
const MAX_RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

const productsCache = new TtlCache<DeltaProductsPayload>(PRODUCTS_TTL_MS, 4);
const candlesCache = new TtlCache<DeltaCandlesPayload>(CANDLES_TTL_MS, 200);

const loggedShapes = new Set<string>();

let lastRestSuccessAt: string | null = null;
let lastRestError: string | null = null;

export class DeltaApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 502, code = 'DELTA_UPSTREAM_ERROR') {
    super(message);
    this.name = 'DeltaApiError';
    this.status = status;
    this.code = code;
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
  console.log(`[DeltaClient] Inspected ${label} keys:`, keys);
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDeltaJson<T>(pathAndQuery: string): Promise<T> {
  const url = `${DELTA_REST_BASE}${pathAndQuery}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'RegimeSentinel/1.0 (read-only-market-monitor)',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const waitMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 10_000)
            : 500 * Math.pow(2, attempt);
        if (attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(waitMs);
          continue;
        }
        throw new DeltaApiError(
          `Delta Exchange rate limit reached (HTTP 429) for ${pathAndQuery}`,
          429,
          'DELTA_RATE_LIMITED',
        );
      }

      if (response.status >= 500 && attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(300 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 120));
        continue;
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new DeltaApiError(
          `Delta Exchange returned HTTP ${response.status}: ${bodyText.slice(0, 240) || response.statusText}`,
          response.status >= 400 && response.status < 500 ? response.status : 502,
          'DELTA_HTTP_ERROR',
        );
      }

      const json = (await response.json()) as {
        success?: boolean;
        result?: T;
        error?: { code?: string; message?: string };
      };

      if (json && json.success === false) {
        throw new DeltaApiError(
          json.error?.message || `Delta Exchange error: ${json.error?.code || 'unknown'}`,
          502,
          json.error?.code || 'DELTA_API_FALSE',
        );
      }

      lastRestSuccessAt = new Date().toISOString();
      lastRestError = null;
      return json as unknown as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof DeltaApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        break;
      }
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(300 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 120));
      }
    }
  }

  const message =
    lastErr instanceof Error ? lastErr.message : 'Unknown error contacting Delta Exchange India';
  lastRestError = message;
  if (lastErr instanceof DeltaApiError) {
    throw lastErr;
  }
  throw new DeltaApiError(message, 502, 'DELTA_NETWORK_ERROR');
}

export function normalizeTickerRecord(
  raw: Record<string, unknown>,
  fallbackSymbol?: string,
): DeltaTickerSnapshot {
  const contractType = typeof raw.contract_type === 'string' ? raw.contract_type : 'unknown';
  const isOption = contractType === 'call_options' || contractType === 'put_options';

  const quotes =
    raw.quotes && typeof raw.quotes === 'object'
      ? (raw.quotes as Record<string, unknown>)
      : {};

  const rawGreeks =
    raw.greeks && typeof raw.greeks === 'object'
      ? (raw.greeks as Record<string, unknown>)
      : null;

  const greeks: DeltaOptionGreeks | null = rawGreeks
    ? {
        delta: toNullableNumber(rawGreeks.delta),
        gamma: toNullableNumber(rawGreeks.gamma),
        theta: toNullableNumber(rawGreeks.theta),
        vega: toNullableNumber(rawGreeks.vega),
        rho: toNullableNumber(rawGreeks.rho),
        spot: toNullableNumber(rawGreeks.spot),
      }
    : null;

  const markVolRaw = toNullableNumber(raw.mark_vol);
  const markIvRaw = toNullableNumber(quotes.mark_iv);
  const bidIvRaw = toNullableNumber(quotes.bid_iv);
  const askIvRaw = toNullableNumber(quotes.ask_iv);

  return {
    symbol: typeof raw.symbol === 'string' ? raw.symbol : fallbackSymbol || '',
    productId: toNullableNumber(raw.product_id),
    contractType,
    description: typeof raw.description === 'string' ? raw.description : '',
    underlyingSymbol:
      typeof raw.underlying_asset_symbol === 'string' ? raw.underlying_asset_symbol : '',
    close: toNullableNumber(raw.close),
    open: toNullableNumber(raw.open),
    high: toNullableNumber(raw.high),
    low: toNullableNumber(raw.low),
    volume: toNullableNumber(raw.volume),
    turnoverUsd: toNullableNumber(raw.turnover_usd),
    markPrice: toNullableNumber(raw.mark_price),
    spotPrice: toNullableNumber(raw.spot_price),
    markBasis: toNullableNumber(raw.mark_basis),
    fundingRate: toNullableNumber(raw.funding_rate),
    oi: toNullableNumber(raw.oi),
    oiContracts: toNullableNumber(raw.oi_contracts),
    oiValueUsd: toNullableNumber(raw.oi_value_usd),
    oiChangeUsd6h: toNullableNumber(raw.oi_change_usd_6h),
    markChange24h: toNullableNumber(raw.mark_change_24h),
    ltpChange24h: toNullableNumber(raw.ltp_change_24h),
    markHigh24h: toNullableNumber(raw.mark_high_24h),
    markLow24h: toNullableNumber(raw.mark_low_24h),
    bestBid: toNullableNumber(quotes.best_bid),
    bestAsk: toNullableNumber(quotes.best_ask),
    bidSize: toNullableNumber(quotes.bid_size),
    askSize: toNullableNumber(quotes.ask_size),
    markVol: isOption ? markVolRaw : null,
    bidIv: isOption ? bidIvRaw : null,
    askIv: isOption ? askIvRaw : null,
    markIv: isOption && markIvRaw !== null && markIvRaw > 0 ? markIvRaw : null,
    greeks,
    strikePrice: toNullableNumber(raw.strike_price),
    leverage: toNullableNumber(raw.leverage),
    tickSize: toNullableNumber(raw.tick_size),
    productTradingStatus:
      typeof raw.product_trading_status === 'string' ? raw.product_trading_status : null,
    exchangeTimeIso: typeof raw.time === 'string' ? raw.time : null,
    exchangeTimestampUs: toNullableNumber(raw.timestamp),
    fetchedAtIso: new Date().toISOString(),
  };
}

export async function fetchLiveProducts(): Promise<{
  payload: DeltaProductsPayload;
  cached: boolean;
  fetchedAt: string;
}> {
  const cached = productsCache.get('live_products');
  if (cached) {
    return {
      payload: cached.value,
      cached: true,
      fetchedAt: new Date(Date.now() - cached.ageMs).toISOString(),
    };
  }

  const allProducts: DeltaProductSummary[] = [];
  let afterCursor: string | null = null;
  let totalCount = 0;
  const maxPages = 12;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      contract_types: 'perpetual_futures,call_options,put_options',
      states: 'live',
      page_size: '200',
    });
    if (afterCursor) {
      params.set('after', afterCursor);
    }

    const json = await fetchDeltaJson<{
      result?: Array<Record<string, unknown>>;
      meta?: { after?: string | null; total_count?: number };
    }>(`/v2/products?${params.toString()}`);

    const batch = Array.isArray(json.result) ? json.result : [];
    if (page === 0 && batch.length > 0) {
      logShapeOnce('REST /v2/products[0]', batch[0]);
    }
    if (typeof json.meta?.total_count === 'number') {
      totalCount = json.meta.total_count;
    }

    for (const item of batch) {
      const symbol = typeof item.symbol === 'string' ? item.symbol : '';
      const id = typeof item.id === 'number' ? item.id : Number(item.id);
      if (!symbol || !Number.isFinite(id)) {
        continue;
      }
      const underlyingObj =
        item.underlying_asset && typeof item.underlying_asset === 'object'
          ? (item.underlying_asset as Record<string, unknown>)
          : null;
      const settlingObj =
        item.settling_asset && typeof item.settling_asset === 'object'
          ? (item.settling_asset as Record<string, unknown>)
          : null;

      const uiConfig =
        item.ui_config && typeof item.ui_config === 'object'
          ? (item.ui_config as Record<string, unknown>)
          : null;

      allProducts.push({
        id,
        symbol,
        description: typeof item.description === 'string' ? item.description : symbol,
        shortDescription:
          typeof item.short_description === 'string' ? item.short_description : null,
        contractType:
          typeof item.contract_type === 'string' ? item.contract_type : 'unknown',
        underlyingSymbol:
          underlyingObj && typeof underlyingObj.symbol === 'string'
            ? underlyingObj.symbol
            : '',
        settlingSymbol:
          settlingObj && typeof settlingObj.symbol === 'string' ? settlingObj.symbol : '',
        tickSize: typeof item.tick_size === 'string' ? item.tick_size : String(item.tick_size ?? ''),
        contractValue:
          typeof item.contract_value === 'string'
            ? item.contract_value
            : String(item.contract_value ?? ''),
        strikePrice:
          item.strike_price !== null && item.strike_price !== undefined
            ? String(item.strike_price)
            : null,
        settlementTime:
          typeof item.settlement_time === 'string' ? item.settlement_time : null,
        tradingStatus:
          typeof item.trading_status === 'string' ? item.trading_status : 'unknown',
        defaultLeverage:
          item.default_leverage !== null && item.default_leverage !== undefined
            ? String(item.default_leverage)
            : null,
        makerCommissionRate:
          item.maker_commission_rate !== null && item.maker_commission_rate !== undefined
            ? String(item.maker_commission_rate)
            : null,
        takerCommissionRate:
          item.taker_commission_rate !== null && item.taker_commission_rate !== undefined
            ? String(item.taker_commission_rate)
            : null,
        sortPriority: uiConfig ? toNullableNumber(uiConfig.sort_priority) : null,
      });
    }

    const nextAfter = json.meta?.after;
    if (!nextAfter || batch.length === 0) {
      break;
    }
    afterCursor = nextAfter;
  }

  // Sort perpetuals first, then by Delta Exchange's own sort_priority, then alphabetically
  allProducts.sort((a, b) => {
    const aIsPerp = a.contractType === 'perpetual_futures' ? 0 : 1;
    const bIsPerp = b.contractType === 'perpetual_futures' ? 0 : 1;
    if (aIsPerp !== bIsPerp) {
      return aIsPerp - bIsPerp;
    }
    const aPrio = a.sortPriority ?? Number.MAX_SAFE_INTEGER;
    const bPrio = b.sortPriority ?? Number.MAX_SAFE_INTEGER;
    if (aPrio !== bPrio) {
      return aPrio - bPrio;
    }
    return a.symbol.localeCompare(b.symbol);
  });

  const underlyings = Array.from(
    new Set(allProducts.map((p) => p.underlyingSymbol).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));

  const payload: DeltaProductsPayload = {
    products: allProducts,
    underlyings,
    totalCount: totalCount || allProducts.length,
  };

  productsCache.set('live_products', payload);
  return {
    payload,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchTickerSnapshot(symbol: string): Promise<{
  ticker: DeltaTickerSnapshot;
  fetchedAt: string;
}> {
  const json = await fetchDeltaJson<{ result?: Record<string, unknown> }>(
    `/v2/tickers/${encodeURIComponent(symbol)}`,
  );

  if (!json.result || typeof json.result !== 'object') {
    throw new DeltaApiError(`No ticker data returned for symbol ${symbol}`, 404, 'TICKER_NOT_FOUND');
  }

  logShapeOnce('REST /v2/tickers/:symbol', json.result);
  const ticker = normalizeTickerRecord(json.result, symbol);
  return {
    ticker,
    fetchedAt: ticker.fetchedAtIso,
  };
}

export async function fetchCandlesHistory(params: {
  symbol: string;
  resolution: CandleResolution;
  start: number;
  end: number;
  basis: CandlePriceBasis;
}): Promise<{
  payload: DeltaCandlesPayload;
  cached: boolean;
  fetchedAt: string;
}> {
  const querySymbol = params.basis === 'mark' ? `MARK:${params.symbol}` : params.symbol;
  const cacheKey = `${querySymbol}:${params.resolution}:${params.start}:${params.end}`;

  const cached = candlesCache.get(cacheKey);
  if (cached) {
    return {
      payload: cached.value,
      cached: true,
      fetchedAt: new Date(Date.now() - cached.ageMs).toISOString(),
    };
  }

  const qs = new URLSearchParams({
    symbol: querySymbol,
    resolution: params.resolution,
    start: String(params.start),
    end: String(params.end),
  });

  const json = await fetchDeltaJson<{ result?: Array<Record<string, unknown>> }>(
    `/v2/history/candles?${qs.toString()}`,
  );

  const rawRows = Array.isArray(json.result) ? json.result : [];
  if (rawRows.length > 0) {
    logShapeOnce('REST /v2/history/candles[0]', rawRows[0]);
  }

  const byTime = new Map<number, DeltaCandle>();
  for (const row of rawRows) {
    const time = toNullableNumber(row.time);
    const open = toNullableNumber(row.open);
    const high = toNullableNumber(row.high);
    const low = toNullableNumber(row.low);
    const close = toNullableNumber(row.close);
    const volume = toNullableNumber(row.volume) ?? 0;

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    byTime.set(Math.floor(time), {
      time: Math.floor(time),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  const payload: DeltaCandlesPayload = {
    symbol: params.symbol,
    querySymbol,
    resolution: params.resolution,
    basis: params.basis,
    start: params.start,
    end: params.end,
    candles,
  };

  candlesCache.set(cacheKey, payload);
  return {
    payload,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}

export async function checkDeltaRestHealth(): Promise<{
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}> {
  const started = Date.now();
  try {
    await fetchDeltaJson<{ result?: unknown[] }>('/v2/products?page_size=1');
    return {
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'REST health check failed',
    };
  }
}

export function getClientTelemetry() {
  const productsEntry = productsCache.get('live_products');
  return {
    lastRestSuccessAt,
    lastRestError,
    productsCached: productsEntry !== null,
    productsAgeMs: productsEntry ? productsEntry.ageMs : null,
    candleCacheEntries: candlesCache.size,
  };
}
