export interface AlpacaBar {
  t: string; // ISO 8601 timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  n: number; // trade count
  vw: number; // volume-weighted average price
}

export type AlpacaTimeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

export const ALPACA_TIMEFRAMES: readonly AlpacaTimeframe[] = [
  '1Min',
  '5Min',
  '15Min',
  '1Hour',
  '1Day',
] as const;

export type AlpacaFeed = 'iex' | 'sip';

// Shared internal candle — identical shape to DeltaCandle in src/contracts/delta.ts
export interface NormalizedCandle {
  time: number; // Unix timestamp in seconds, ascending
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AlpacaStatusResponse {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkedAt: string;
}

export interface AlpacaBarsResponse {
  bars: NormalizedCandle[];
  symbol: string;
  timeframe: AlpacaTimeframe;
  feed: string | null;
  fetchedAt: string;
}

export interface AlpacaValidateResponse {
  valid: boolean;
  symbol: string;
  trade: unknown;
}

export interface AlpacaApiErrorResponse {
  error: string;
  code: string;
  status: number;
  source: string;
  timestamp: string;
}

export interface AlpacaApiEnvelope<T> {
  data: T;
  source: string;
  fetchedAt: string;
  cached: boolean;
}
