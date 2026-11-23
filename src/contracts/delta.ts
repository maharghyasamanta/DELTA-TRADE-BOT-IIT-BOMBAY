export type ContractType = 'perpetual_futures' | 'call_options' | 'put_options' | 'futures';

export type CandleResolution =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '1d';

export type CandlePriceBasis = 'trade' | 'mark';

export const ALLOWED_RESOLUTIONS: readonly CandleResolution[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '1d',
] as const;

export interface DeltaProductSummary {
  id: number;
  symbol: string;
  description: string;
  shortDescription: string | null;
  contractType: string;
  underlyingSymbol: string;
  settlingSymbol: string;
  tickSize: string;
  contractValue: string;
  strikePrice: string | null;
  settlementTime: string | null;
  tradingStatus: string;
  defaultLeverage: string | null;
  makerCommissionRate: string | null;
  takerCommissionRate: string | null;
  sortPriority: number | null;
}

export interface DeltaProductsPayload {
  products: DeltaProductSummary[];
  underlyings: string[];
  totalCount: number;
}

export interface DeltaOptionGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  spot: number | null;
}

export interface DeltaTickerSnapshot {
  symbol: string;
  productId: number | null;
  contractType: string;
  description: string;
  underlyingSymbol: string;
  close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  turnoverUsd: number | null;
  markPrice: number | null;
  spotPrice: number | null;
  markBasis: number | null;
  fundingRate: number | null;
  oi: number | null;
  oiContracts: number | null;
  oiValueUsd: number | null;
  oiChangeUsd6h: number | null;
  markChange24h: number | null;
  ltpChange24h: number | null;
  markHigh24h: number | null;
  markLow24h: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  markVol: number | null;
  bidIv: number | null;
  askIv: number | null;
  markIv: number | null;
  greeks: DeltaOptionGreeks | null;
  strikePrice: number | null;
  leverage: number | null;
  tickSize: number | null;
  productTradingStatus: string | null;
  exchangeTimeIso: string | null;
  exchangeTimestampUs: number | null;
  fetchedAtIso: string;
}

export interface DeltaCandle {
  time: number; // Unix timestamp in seconds (ascending)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DeltaCandlesPayload {
  symbol: string;
  querySymbol: string;
  resolution: CandleResolution;
  basis: CandlePriceBasis;
  start: number;
  end: number;
  candles: DeltaCandle[];
}

export interface ApiEnvelope<T> {
  data: T;
  source: string;
  fetchedAt: string;
  cached: boolean;
}

export interface ApiErrorResponse {
  error: string;
  code: string;
  status: number;
  source: string;
  timestamp: string;
}

export type DeltaWsConnectionState =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface HealthStatusResponse {
  ok: boolean;
  deltaRestOk: boolean;
  deltaRestLatencyMs: number | null;
  deltaWsState: DeltaWsConnectionState;
  lastRestSuccessAt: string | null;
  lastWsMessageAt: string | null;
  lastError: string | null;
  cacheStats: {
    productsCached: boolean;
    productsAgeMs: number | null;
    candleCacheEntries: number;
  };
  checkedAt: string;
}

export type DeltaStreamEvent =
  | {
      type: 'health';
      wsState: DeltaWsConnectionState;
      message?: string;
      timestamp: string;
    }
  | {
      type: 'ticker';
      symbol: string;
      ticker: DeltaTickerSnapshot;
      source: string;
      timestamp: string;
    }
  | {
      type: 'candle';
      symbol: string;
      querySymbol: string;
      resolution: CandleResolution;
      basis: CandlePriceBasis;
      candle: DeltaCandle;
      source: string;
      timestamp: string;
    }
  | {
      type: 'error';
      error: string;
      source: string;
      timestamp: string;
    };
