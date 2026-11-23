import { AlertCircle, RefreshCw } from 'lucide-react';
import type { DeltaTickerSnapshot } from '../contracts/delta';
import {
  formatCompactUsd,
  formatContractTypeLabel,
  formatNumber,
  formatPercent,
  formatPrice,
  formatTimestamp,
} from '../utils/format';

interface LiveTickerStripProps {
  symbol: string | null;
  ticker: DeltaTickerSnapshot | null;
  isLoading: boolean;
  error: { message: string; timestamp: string } | null;
  source: string | null;
  lastUpdated: string | null;
  onRefresh: () => void;
}

export function LiveTickerStrip({
  symbol,
  ticker,
  isLoading,
  error,
  source,
  lastUpdated,
  onRefresh,
}: LiveTickerStripProps) {
  if (!symbol) {
    return (
      <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-5 text-xs text-slate-400">
        Select a live contract from the Instrument Picker to inspect ticker telemetry.
      </section>
    );
  }

  if (isLoading && !ticker) {
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

  if (error && !ticker) {
    return (
      <section className="rounded-lg border border-rose-500/30 bg-rose-950/20 p-4 text-xs text-rose-200">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div className="space-y-1">
              <p className="font-medium">
                Unable to load ticker for <span className="font-mono">{symbol}</span>
              </p>
              <p className="text-rose-300/90">{error.message}</p>
              <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                Timestamp: {formatTimestamp(error.timestamp)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-100 hover:bg-rose-900/40 shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!ticker) {
    return (
      <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-5 text-xs text-slate-400">
        No ticker payload returned by Delta Exchange India for {symbol}.
      </section>
    );
  }

  const isOption =
    ticker.contractType === 'call_options' || ticker.contractType === 'put_options';
  const markChange = ticker.markChange24h;
  const changeTone =
    markChange === null
      ? 'text-slate-400'
      : markChange > 0
        ? 'text-emerald-400'
        : markChange < 0
          ? 'text-rose-400'
          : 'text-slate-300';

  const tickSize = ticker.tickSize;

  return (
    <section
      aria-label="Live Ticker Telemetry"
      className="rounded-lg border border-slate-800/90 bg-[#111A2E] px-5 py-4"
    >
      {/* Top Row: Instrument Identity + Last / Mark / 24h Change */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800/70 pb-3.5">
        <div>
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h1 className="font-mono text-xl font-semibold tracking-tight text-slate-100">
              {ticker.symbol}
            </h1>
            <span className="text-xs text-slate-400">
              {formatContractTypeLabel(ticker.contractType)}
              {ticker.description ? ` · ${ticker.description}` : ''}
              {ticker.productTradingStatus ? ` · ${ticker.productTradingStatus}` : ''}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
            <span>{source || 'Delta Exchange India REST /v2/tickers'}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              Last updated: {formatTimestamp(lastUpdated || ticker.fetchedAtIso)}
            </span>
            {error && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-400">Refresh warning: {error.message}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-[11px] text-slate-400">Mark Price</div>
            <div className="font-mono text-xl font-semibold text-slate-100 tabular-nums">
              {formatPrice(ticker.markPrice, tickSize)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-400">24h Mark Chg</div>
            <div className={`font-mono text-base font-semibold tabular-nums ${changeTone}`}>
              {formatPercent(markChange)}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh ticker snapshot"
            className="rounded-md border border-slate-800 bg-[#0B1120] p-2 text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Primary Metrics Grid (Flat hairline structure, no nested card boxes) */}
      <div className="mt-3.5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricItem
          label="Last Trade"
          value={formatPrice(ticker.close, tickSize)}
        />
        <MetricItem
          label="Spot Index"
          value={formatPrice(ticker.spotPrice, tickSize)}
        />
        <MetricItem
          label="Bid / Ask"
          value={`${formatPrice(ticker.bestBid, tickSize)} / ${formatPrice(ticker.bestAsk, tickSize)}`}
        />
        <MetricItem
          label="24h Range"
          value={`${formatPrice(ticker.low, tickSize)} – ${formatPrice(ticker.high, tickSize)}`}
        />
        <MetricItem
          label="24h Turnover"
          value={formatCompactUsd(ticker.turnoverUsd)}
        />
        <MetricItem
          label="Open Interest"
          value={
            ticker.oiValueUsd !== null
              ? formatCompactUsd(ticker.oiValueUsd)
              : formatNumber(ticker.oiContracts, 0)
          }
        />

        {!isOption ? (
          <>
            <MetricItem
              label="Funding Rate"
              value={
                ticker.fundingRate !== null ? formatPercent(ticker.fundingRate, 4) : '—'
              }
            />
            <MetricItem
              label="Mark Basis"
              value={
                ticker.markBasis !== null ? formatPercent(ticker.markBasis * 100, 4) : '—'
              }
            />
            <MetricItem
              label="6h OI Change"
              value={formatCompactUsd(ticker.oiChangeUsd6h)}
            />
            <MetricItem
              label="OI Contracts"
              value={formatNumber(ticker.oiContracts, 0)}
            />
            <MetricItem
              label="24h Volume"
              value={formatNumber(ticker.volume, 3)}
            />
            <MetricItem
              label="Max Leverage"
              value={ticker.leverage !== null ? `${ticker.leverage}x` : '—'}
            />
          </>
        ) : (
          <>
            <MetricItem
              label="Strike Price"
              value={formatPrice(ticker.strikePrice, 2)}
            />
            <MetricItem
              label="Mark IV"
              value={
                ticker.markVol !== null
                  ? `${(ticker.markVol * 100).toFixed(2)}%`
                  : ticker.markIv !== null
                    ? `${(ticker.markIv * 100).toFixed(2)}%`
                    : '—'
              }
            />
            <MetricItem
              label="Bid / Ask IV"
              value={
                ticker.bidIv !== null || ticker.askIv !== null
                  ? `${ticker.bidIv !== null ? (ticker.bidIv * 100).toFixed(1) + '%' : '—'} / ${ticker.askIv !== null ? (ticker.askIv * 100).toFixed(1) + '%' : '—'}`
                  : '—'
              }
            />
            <MetricItem
              label="Delta / Gamma"
              value={
                ticker.greeks
                  ? `${formatNumber(ticker.greeks.delta, 4)} / ${formatNumber(ticker.greeks.gamma, 5)}`
                  : '—'
              }
            />
            <MetricItem
              label="Theta / Vega"
              value={
                ticker.greeks
                  ? `${formatNumber(ticker.greeks.theta, 3)} / ${formatNumber(ticker.greeks.vega, 3)}`
                  : '—'
              }
            />
            <MetricItem
              label="24h Volume"
              value={formatNumber(ticker.volume, 4)}
            />
          </>
        )}
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
