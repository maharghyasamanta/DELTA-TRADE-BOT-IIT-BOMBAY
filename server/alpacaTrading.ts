import {
  type PaperContractSpec,
  type PaperPositionSide,
  type PaperOrderSide,
  type PaperOrderType,
} from '../src/contracts/paper.ts';

const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID?.trim() ?? '';
const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY?.trim() ?? '';
const ALPACA_BASE_URL = process.env.ALPACA_BASE_URL?.trim() ?? 'https://paper-api.alpaca.markets';

export const ALPACA_TRADING_CONFIGURED = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);

interface AlpacaAccount {
  id: string;
  account_number: string;
  status: string;
  currency: string;
  cash: string;
  buying_power: string;
  equity: string;
  last_equity: string;
  long_market_value: string;
  short_market_value: string;
  portfolio_value: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
  transfers_blocked: boolean;
  account_blocked: boolean;
  created_at: string;
  trade_suspended_by_user: boolean;
  multiplier: string;
  shorting_enabled: boolean;
  sma: string;
  daytrade_count: number;
}

interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  exchange: string;
  asset_class: string;
  avg_entry_price: string;
  qty: string;
  side: 'long' | 'short';
  market_value: string;
  cost_basis: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  unrealized_intraday_plpc: string;
  current_price: string;
  lastday_price: string;
  change_today: string;
  qty_available: string;
}

interface AlpacaOrderRequest {
  symbol: string;
  qty: string | number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  limit_price?: string | number;
  stop_price?: string | number;
  client_order_id?: string;
}

interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  qty: string;
  side: 'buy' | 'sell';
  type: string;
  time_in_force: string;
  status: 'new' | 'partially_filled' | 'filled' | 'done_for_day' | 'canceled' | 'expired' | 'rejected' | 'held' | 'replaced' | 'pending_replace' | 'pending_cancel';
  filled_qty: string;
  filled_avg_price: string | null;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  order_class: string;
  legs: any[] | null;
  trail_price: string | null;
  trail_percent: string | null;
  hwm_price: string | null;
}

async function alpacaRequest(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!ALPACA_TRADING_CONFIGURED) {
    throw new Error('Alpaca Trading not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY');
  }

  const url = `${ALPACA_BASE_URL}${path}`;
  const headers = {
    'APCA-API-KEY-ID': ALPACA_API_KEY_ID,
    'APCA-API-SECRET-KEY': ALPACA_API_SECRET_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Alpaca Trading API error: ${response.status} ${errorBody}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

export async function getAlpacaAccount(): Promise<AlpacaAccount> {
  return alpacaRequest('/v2/account') as Promise<AlpacaAccount>;
}

export async function getAlpacaPositions(): Promise<AlpacaPosition[]> {
  return alpacaRequest('/v2/positions') as Promise<AlpacaPosition[]>;
}

export async function placeAlpacaOrder(order: AlpacaOrderRequest): Promise<AlpacaOrder> {
  return alpacaRequest('/v2/orders', {
    method: 'POST',
    body: JSON.stringify(order),
  }) as Promise<AlpacaOrder>;
}

export async function cancelAlpacaOrder(orderId: string): Promise<void> {
  await alpacaRequest(`/v2/orders/${orderId}`, { method: 'DELETE' });
}

export async function closeAllAlpacaPositions(): Promise<unknown> {
  return alpacaRequest('/v2/positions', { method: 'DELETE' });
}

/**
 * Convert Alpaca position side to our internal side
 */
export function alpacaSideToPositionSide(side: string): PaperPositionSide {
  return side === 'long' ? 'LONG' : 'SHORT';
}

/**
 * Convert our order side to Alpaca format
 */
export function positionSideToAlpacaSide(side: PaperPositionSide): 'buy' | 'sell' {
  return side === 'LONG' ? 'buy' : 'sell';
}

/**
 * Format price for Alpaca API (remove trailing zeros, ensure valid float string)
 */
export function formatAlpacaPrice(price: number): string {
  return price.toFixed(2);
}

/**
 * Map order type to Alpaca format
 */
export function orderTypeToAlpaca(type: PaperOrderType): AlpacaOrderRequest['type'] {
  return type === 'MARKET' ? 'market' : 'limit';
}
