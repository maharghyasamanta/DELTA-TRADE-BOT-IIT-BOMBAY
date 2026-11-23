import { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import {
  DEFAULT_CUSUM_DECAY_BARS,
  DEFAULT_CUSUM_H,
  DEFAULT_CUSUM_K,
  DEFAULT_CUSUM_VOL_WINDOW,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_TREND_WINDOW,
  DEFAULT_VOL_LOOKBACK,
  DEFAULT_VOL_WINDOW,
  type RegimeSeriesResult,
} from '../engine/regime';
import { formatNumber } from '../utils/format';

interface RegimePanelProps {
  result: RegimeSeriesResult;
  sourceLabel: 'Delta' | 'Alpaca';
  timeframeLabel: string;
  symbol: string | null;
}

function formatUtcCandleTime(unixSec: number | null): string {
  if (unixSec === null || !Number.isFinite(unixSec)) return '—';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function InsufficientBadge({ required, actual }: { required: number; actual: number }) {
  return (
    <span className="block font-mono text-xs font-normal text-amber-300/90 tabular-nums">
      Insufficient data (need {required} bars, have {actual})
    </span>
  );
}

export function RegimePanel({
  result,
  sourceLabel,
  timeframeLabel,
  symbol,
}: RegimePanelProps) {
  const [showFormula, setShowFormula] = useState(false);

  const { latest, meta, markers } = result;
  const { options } = meta;

  const requiredForScore = Math.max(meta.requiredBarsForVolZ, meta.requiredBarsForTrend);
  const hasScore = latest.score !== null;
  const hasVolZ = latest.volZ !== null;
  const hasTrend = latest.trend !== null;
  const hasCusumWindow = meta.candleCount >= meta.requiredBarsForCusum;

  const lastMarker = markers.length > 0 ? markers[markers.length - 1] : null;

  return (
    <section
      aria-label="Market Regime Statistics"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
        <div className="space-y-0.5">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Descriptive Regime Statistics
          </h2>
          <p className="text-[11px] text-slate-400">
            Descriptive statistics of loaded candles only (non-predictive)
            {symbol ? (
              <>
                {' '}
                · <span className="font-mono text-slate-300">{symbol}</span>
              </>
            ) : null}
          </p>
        </div>

        <button
          type="button"
          aria-expanded={showFormula}
          onClick={() => setShowFormula((prev) => !prev)}
          className="flex items-center gap-1.5 rounded-md border border-slate-800 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 cursor-pointer transition-colors duration-150"
        >
          {showFormula ? (
            <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
          )}
          <span>How this is calculated</span>
        </button>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 gap-px bg-slate-800/70 sm:grid-cols-2 xl:grid-cols-4">
        {/* Regime Intensity Score */}
        <div className="flex flex-col justify-between bg-[#111A2E] px-5 py-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Regime Score (0–100)
          </span>
          <div className="mt-2">
            {hasScore && latest.score !== null ? (
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold text-slate-100 tabular-nums">
                  {latest.score.toFixed(1)}
                </span>
                <span className="font-mono text-xs text-slate-400">/ 100</span>
              </div>
            ) : (
              <InsufficientBadge required={requiredForScore} actual={meta.candleCount} />
            )}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
            <span className="font-mono text-slate-300">
              w={options.weights.volatility}/{options.weights.trend}/{options.weights.cusum}
            </span>{' '}
            · Vol z-score, |trend|, CUSUM decay ({options.cusumDecayBars} bars)
          </p>
        </div>

        {/* Volatility Z-Score */}
        <div className="flex flex-col justify-between bg-[#111A2E] px-5 py-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Volatility Z-Score
          </span>
          <div className="mt-2">
            {hasVolZ && latest.volZ !== null ? (
              <span
                className={`font-mono text-2xl font-semibold tabular-nums ${
                  latest.volZ >= 1.5
                    ? 'text-amber-300'
                    : latest.volZ <= -1.0
                      ? 'text-sky-300'
                      : 'text-slate-100'
                }`}
              >
                {latest.volZ > 0 ? `+${latest.volZ.toFixed(2)}` : latest.volZ.toFixed(2)}σ
              </span>
            ) : (
              <InsufficientBadge required={meta.requiredBarsForVolZ} actual={meta.candleCount} />
            )}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
            <span className="font-mono text-slate-300">
              W={options.volWindow}, L={options.volLookback}
            </span>{' '}
            · {options.volWindow}-bar return stdev vs {options.volLookback}-bar lookback
          </p>
        </div>

        {/* Trend Strength */}
        <div className="flex flex-col justify-between bg-[#111A2E] px-5 py-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Trend Strength
          </span>
          <div className="mt-2">
            {hasTrend && latest.trend !== null ? (
              <span
                className={`font-mono text-2xl font-semibold tabular-nums ${
                  latest.trend > 0.25
                    ? 'text-emerald-400'
                    : latest.trend < -0.25
                      ? 'text-rose-400'
                      : 'text-slate-100'
                }`}
              >
                {latest.trend > 0 ? `+${latest.trend.toFixed(3)}` : latest.trend.toFixed(3)}
              </span>
            ) : (
              <InsufficientBadge required={meta.requiredBarsForTrend} actual={meta.candleCount} />
            )}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
            <span className="font-mono text-slate-300">W={options.trendWindow} bars</span> · Signed
            OLS R² of close vs index ([−1, +1])
          </p>
        </div>

        {/* CUSUM Change Points */}
        <div className="flex flex-col justify-between bg-[#111A2E] px-5 py-4">
          <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            CUSUM Change Points
          </span>
          <div className="mt-2">
            {hasCusumWindow ? (
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold text-slate-100 tabular-nums">
                  {formatNumber(latest.cusumCount, 0)}
                </span>
                <span className="font-mono text-xs text-slate-400">
                  {latest.cusumCount === 1 ? 'event in window' : 'events in window'}
                </span>
              </div>
            ) : (
              <InsufficientBadge required={meta.requiredBarsForCusum} actual={meta.candleCount} />
            )}
          </div>
          <p className="mt-2.5 font-mono text-[11px] leading-relaxed text-slate-400 tabular-nums">
            <span className="text-slate-300">
              W={options.cusumVolWindow}, k={options.cusumK}, h={options.cusumH}
            </span>{' '}
            ·{' '}
            {lastMarker
              ? `Last: ${lastMarker.direction === 'up' ? 'CP+' : 'CP-'} at ${formatUtcCandleTime(lastMarker.time)}`
              : hasCusumWindow
                ? 'No crossings in window'
                : `Requires ${meta.requiredBarsForCusum} bars`}
          </p>
        </div>
      </div>

      {/* Non-positive close warning if any bar was skipped */}
      {meta.skippedNonPositiveCloses > 0 && (
        <div className="flex items-center gap-2 border-t border-amber-500/30 bg-amber-950/20 px-5 py-2 text-xs text-amber-200">
          <Info className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span className="font-mono">
            Skipped {meta.skippedNonPositiveCloses} bar transition(s) with non-positive close (no
            padding or interpolation applied).
          </span>
        </div>
      )}

      {/* Collapsible Formula Documentation */}
      {showFormula && (
        <div className="border-t border-slate-800/80 bg-[#0B1120]/80 px-5 py-4 text-xs text-slate-300 space-y-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Deterministic Formulas &amp; Active Constants (Descriptive Only)
          </p>
          <ul className="space-y-1.5 font-mono text-[11px] leading-relaxed text-slate-300">
            <li>
              <span className="text-slate-100">1. Log Returns:</span> r_t = ln(close_t /
              close_&#123;t-1&#125;). Any non-positive close is skipped and reported.
            </li>
            <li>
              <span className="text-slate-100">2. Volatility Z-Score:</span> sample stdev
              σ_t (ddof=1) over {DEFAULT_VOL_WINDOW} log returns, standardized against the trailing{' '}
              {DEFAULT_VOL_LOOKBACK} values of σ_t: z_t = (σ_t − μ_σ) / s_σ (or 0 if s_σ ≤ 1e-12).
              Requires {DEFAULT_VOL_WINDOW + DEFAULT_VOL_LOOKBACK} bars.
            </li>
            <li>
              <span className="text-slate-100">3. Trend Strength:</span> OLS linear regression of
              close vs bar index over {DEFAULT_TREND_WINDOW} bars: sign(slope) × R² ∈ [−1, +1] (0 on
              flat series).
            </li>
            <li>
              <span className="text-slate-100">4. Two-Sided CUSUM:</span> z_t = r_t / σ_&#123;t-1&#125;
              using lagged {DEFAULT_CUSUM_VOL_WINDOW}-bar stdev; S⁺ = max(0, S⁺ + z_t − k), S⁻ =
              max(0, S⁻ − z_t − k) with slack k = {DEFAULT_CUSUM_K} and threshold h ={' '}
              {DEFAULT_CUSUM_H}; resets both accumulators after crossing h.
            </li>
            <li>
              <span className="text-slate-100">5. Regime Score:</span> clamped 100 × (
              {DEFAULT_SCORE_WEIGHTS.volatility}·clamp01((volZ+1)/4) +{' '}
              {DEFAULT_SCORE_WEIGHTS.trend}·|trend| +{' '}
              {DEFAULT_SCORE_WEIGHTS.cusum}·max(0, 1 − barsSinceCusum/{DEFAULT_CUSUM_DECAY_BARS}))
              onto [0, 100]. Returns null if volZ or trend is null.
            </li>
          </ul>
        </div>
      )}

      {/* Provenance Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 font-mono text-[11px] text-slate-400 tabular-nums">
        <span>
          Computed from {meta.candleCount} candles · Source: {sourceLabel} · Window:{' '}
          {timeframeLabel} · Last candle: {formatUtcCandleTime(latest.time)}
        </span>
      </div>
    </section>
  );
}
