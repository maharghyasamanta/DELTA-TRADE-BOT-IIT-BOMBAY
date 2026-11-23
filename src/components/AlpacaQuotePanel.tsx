import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import {
  fetchAlpacaLatestQuote,
  fetchAlpacaLatestTrade,
  ProxyRequestError,
} from '../api/alpacaApi';
import {
  formatDateTimeUtc,
  formatNumber,
  formatPrice,
  formatTimestamp,
} from '../utils/format';

const REFRESH_INTERVAL_MS = 10_000;
const NOT_CONFIGURED_MESSAGE =
  'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment';

interface AlpacaQuoteData {
  t?: string;
  bp?: number;
  bs?: number;
  bx?: string;
  ap?: number;
  as?: number;
  ax?: string;
  c?: string[];
  z?: string;
}

interface AlpacaTradeData {
  t?: string;
  p?: number;
  s?: number;
  x?: string;
  c?: string[];
  i?: number;
  z?: string;
}

interface PanelError {
  message: string;
  timestamp: string;
  code?: string;
}

interface AlpacaQuotePanelProps {
  symbol: string | null;
  configured: boolean | null;
  onAfterRequest?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractQuoteData(raw: unknown): AlpacaQuoteData | null {
  if (!isRecord(raw)) return null;
  const candidate = isRecord(raw.quote) ? raw.quote : raw;
  const out: AlpacaQuoteData = {};
  if (typeof candidate.t === 'string') out.t = candidate.t;
  if (typeof candidate.bp === 'number' && Number.isFinite(candidate.bp)) out.bp = candidate.bp;
  if (typeof candidate.bs === 'number' && Number.isFinite(candidate.bs)) out.bs = candidate.bs;
  if (typeof candidate.bx === 'string') out.bx = candidate.bx;
  if (typeof candidate.ap === 'number' && Number.isFinite(candidate.ap)) out.ap = candidate.ap;
  if (typeof candidate.as === 'number' && Number.isFinite(candidate.as)) out.as = candidate.as;
  if (typeof candidate.ax === 'string') out.ax = candidate.ax;
  if (typeof candidate.z === 'string') out.z = candidate.z;
  if (Array.isArray(candidate.c)) {
    out.c = candidate.c.filter((item): item is string => typeof item === 'string');
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractTradeData(raw: unknown): AlpacaTradeData | null {
  if (!isRecord(raw)) return null;
  const candidate = isRecord(raw.trade) ? raw.trade : raw;
  const out: AlpacaTradeData = {};
  if (typeof candidate.t === 'string') out.t = candidate.t;
  if (typeof candidate.p === 'number' && Number.isFinite(candidate.p)) out.p = candidate.p;
  if (typeof candidate.s === 'number' && Number.isFinite(candidate.s)) out.s = candidate.s;
  if (typeof candidate.x === 'string') out.x = candidate.x;
  if (typeof candidate.i === 'number' && Number.isFinite(candidate.i)) out.i = candidate.i;
  if (typeof candidate.z === 'string') out.z = candidate.z;
  if (Array.isArray(candidate.c)) {
    out.c = candidate.c.filter((item): item is string => typeof item === 'string');
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function AlpacaQuotePanel({
  symbol,
  configured,
  onAfterRequest,
}: AlpacaQuotePanelProps) {
  const [quote, setQuote] = useState<AlpacaQuoteData | null>(null);
  const [trade, setTrade] = useState<AlpacaTradeData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const onAfterRequestRef = useRef(onAfterRequest);
  onAfterRequestRef.current = onAfterRequest;

  const loadSnapshot = useCallback(
    async (targetSymbol: string, signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);

      const [quoteRes, tradeRes] = await Promise.allSettled([
        fetchAlpacaLatestQuote(targetSymbol, signal),
        fetchAlpacaLatestTrade(targetSymbol, signal),
      ]);

      if (signal?.aborted) return;

      const errors: string[] = [];
      let errorTimestamp = new Date().toISOString();
      let errorCode: string | undefined;
      let latestFetchedAt: string | null = null;

      if (quoteRes.status === 'fulfilled') {
        setQuote(extractQuoteData(quoteRes.value.data));
        latestFetchedAt = quoteRes.value.fetchedAt;
      } else {
        setQuote(null);
        const reason = quoteRes.reason;
        if (reason instanceof ProxyRequestError) {
          errors.push(`Quote: ${reason.message}`);
          errorTimestamp = reason.timestamp;
          errorCode = reason.code;
        } else {
          errors.push(`Quote: ${reason instanceof Error ? reason.message : 'Request failed'}`);
        }
      }

      if (tradeRes.status === 'fulfilled') {
        setTrade(extractTradeData(tradeRes.value.data));
        latestFetchedAt = tradeRes.value.fetchedAt || latestFetchedAt;
      } else {
        setTrade(null);
        const reason = tradeRes.reason;
        if (reason instanceof ProxyRequestError) {
          errors.push(`Trade: ${reason.message}`);
          errorTimestamp = reason.timestamp;
          errorCode = errorCode ?? reason.code;
        } else {
          errors.push(`Trade: ${reason instanceof Error ? reason.message : 'Request failed'}`);
        }
      }

      if (latestFetchedAt) {
        setLastUpdated(latestFetchedAt);
      }

      if (errors.length > 0) {
        setError({
          message: errors.join(' | '),
          timestamp: errorTimestamp,
          code: errorCode,
        });
      }

      setIsLoading(false);
      onAfterRequestRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (configured === false) {
      setQuote(null);
      setTrade(null);
      setIsLoading(false);
      setError({
        message: NOT_CONFIGURED_MESSAGE,
        timestamp: new Date().toISOString(),
        code: 'ALPACA_NOT_CONFIGURED',
      });
      setLastUpdated(null);
      return;
    }

    if (!symbol) {
      setQuote(null);
      setTrade(null);
      setIsLoading(false);
      setError(null);
      setLastUpdated(null);
      return;
    }

    let activeController = new AbortController();
    void loadSnapshot(symbol, activeController.signal);

    let timer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          activeController.abort();
          activeController = new AbortController();
          void loadSnapshot(symbol, activeController.signal);
        }
      }, REFRESH_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        activeController.abort();
        activeController = new AbortController();
        void loadSnapshot(symbol, activeController.signal);
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === 'visible') {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      activeController.abort();
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [symbol, configured, loadSnapshot]);

  if (!symbol) {
    return (
      <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-5 text-xs text-slate-400">
        Enter and validate a US equity ticker in the Instrument Picker to inspect Alpaca latest quote and trade telemetry.
      </section>
    );
  }

  if (isLoading && !quote && !trade && !error) {
    return (
      <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-5">
        <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="h-10 animate-pulse rounded bg-slate-900/80" />
          ))}
        </div>
      </section>
    );
  }

  if (error && !quote && !trade) {
    return (
      <section
        aria-label="Alpaca Latest Quote and Trade"
        className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-4 text-xs text-rose-200"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium">
                Unable to load Alpaca quote/trade for <span className="font-mono">{symbol}</span>
              </p>
              <p className="text-rose-300/90">
                {error.code === 'ALPACA_NOT_CONFIGURED' ? NOT_CONFIGURED_MESSAGE : error.message}
              </p>
              <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                Timestamp: {formatTimestamp(error.timestamp)}
              </p>
            </div>
          </div>
          {configured !== false && (
            <button
              type="button"
              onClick={() => void loadSnapshot(symbol)}
              className="rounded border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-900/40 shrink-0 cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Alpaca Latest Quote and Trade"
      className="rounded-lg border border-slate-800/90 bg-[#111A2E] px-5 py-4"
    >
      {/* Top Row: Symbol Identity + Latest Trade Price + Refresh */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/70 pb-3.5">
        <div>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-100">
              {symbol}
            </h1>
            <span className="text-xs text-slate-400">
              US Equity · Alpaca Market Data
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>
              Source: Alpaca Market Data /v2/stocks/{symbol}/quotes/latest and /trades/latest, last updated:{' '}
              <span className="font-mono tabular-nums">{formatTimestamp(lastUpdated)}</span>
            </span>
            {error && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-400">
                  Partial error ({formatTimestamp(error.timestamp)}): {error.message}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-6">
          {trade?.p !== undefined && (
            <div className="text-right">
              <div className="text-[11px] text-slate-400">Last Trade</div>
              <div className="font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {formatPrice(trade.p, 0.01)}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void loadSnapshot(symbol)}
            disabled={isLoading}
            title="Refresh Alpaca quote and trade"
            className="rounded-md border border-slate-800 bg-[#0B1120] p-2 text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Metrics Grid — only fields actually present in the real Alpaca responses */}
      <div className="mt-3.5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {quote?.bp !== undefined && (
          <MetricItem label="Bid Price (bp)" value={formatPrice(quote.bp, 0.01)} />
        )}
        {quote?.bs !== undefined && (
          <MetricItem label="Bid Size (bs)" value={formatNumber(quote.bs, 0)} />
        )}
        {quote?.bx !== undefined && <MetricItem label="Bid Exchange (bx)" value={quote.bx} />}
        {quote?.ap !== undefined && (
          <MetricItem label="Ask Price (ap)" value={formatPrice(quote.ap, 0.01)} />
        )}
        {quote?.as !== undefined && (
          <MetricItem label="Ask Size (as)" value={formatNumber(quote.as, 0)} />
        )}
        {quote?.ax !== undefined && <MetricItem label="Ask Exchange (ax)" value={quote.ax} />}
        {quote?.t !== undefined && (
          <MetricItem label="Quote Timestamp (t)" value={formatDateTimeUtc(quote.t)} />
        )}
        {quote?.z !== undefined && <MetricItem label="Quote Tape (z)" value={quote.z} />}
        {quote?.c !== undefined && quote.c.length > 0 && (
          <MetricItem label="Quote Conditions (c)" value={quote.c.join(', ')} />
        )}

        {trade?.p !== undefined && (
          <MetricItem label="Trade Price (p)" value={formatPrice(trade.p, 0.01)} />
        )}
        {trade?.s !== undefined && (
          <MetricItem label="Trade Size (s)" value={formatNumber(trade.s, 0)} />
        )}
        {trade?.x !== undefined && <MetricItem label="Trade Exchange (x)" value={trade.x} />}
        {trade?.t !== undefined && (
          <MetricItem label="Trade Timestamp (t)" value={formatDateTimeUtc(trade.t)} />
        )}
        {trade?.i !== undefined && (
          <MetricItem label="Trade ID (i)" value={String(trade.i)} />
        )}
        {trade?.z !== undefined && <MetricItem label="Trade Tape (z)" value={trade.z} />}
        {trade?.c !== undefined && trade.c.length > 0 && (
          <MetricItem label="Trade Conditions (c)" value={trade.c.join(', ')} />
        )}
      </div>

      {/* Provenance Footer */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-2.5 text-[11px] text-slate-400">
        <span>Source: Alpaca</span>
        <span className="font-mono tabular-nums">
          Last updated: {formatTimestamp(lastUpdated)}
        </span>
      </div>
    </section>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400 truncate">{label}</div>
      <div className="mt-0.5 font-mono text-xs font-medium text-slate-100 tabular-nums truncate">
        {value}
      </div>
    </div>
  );
}
