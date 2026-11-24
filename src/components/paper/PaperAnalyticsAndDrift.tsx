import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { PaperDriftReport, PaperTradeAnalytics } from '../../contracts/paper';
import { formatFixedUnits, stringToUnits } from '../../engine/decimal';

interface PaperAnalyticsAndDriftProps {
  analytics: PaperTradeAnalytics | null;
  drift: PaperDriftReport | null;
  onRefresh: () => Promise<void>;
}

export function PaperAnalyticsAndDrift({
  analytics,
  drift,
  onRefresh,
}: PaperAnalyticsAndDriftProps) {
  const fmtUsd = (units: string, d = 2) => formatFixedUnits(stringToUnits(units), d);
  const fmtPct = (v: number | null) => (v !== null ? `${(v * 100).toFixed(1)}%` : '—');

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Paper Performance Analytics & Backtest Drift
          </h3>
          <p className="text-xs text-slate-400">
            Wilson 95% intervals, guardrail/score attribution, and execution drift vs. causal backtest
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100 cursor-pointer"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Recompute
        </button>
      </div>

      {analytics?.insufficientSample && (
        <div
          role="status"
          className="flex items-center gap-2 rounded border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>
            Insufficient sample ({analytics.totalTrades} / {analytics.minSampleThreshold} trades) — win
            rate and expectancy carry wide statistical uncertainty in this sample.
          </span>
        </div>
      )}

      {analytics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 font-mono text-xs tabular-nums">
          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Win Rate (95% CI)</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              {fmtPct(analytics.winRate)}
            </div>
            <div className="text-[11px] text-slate-400">
              {analytics.wilson95
                ? `[${(analytics.wilson95.low * 100).toFixed(1)}%, ${(analytics.wilson95.high * 100).toFixed(1)}%]`
                : '—'}
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Expectancy / Trade</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              ${fmtUsd(analytics.expectancyUnits)}
            </div>
            <div className="text-[11px] text-slate-400">
              {analytics.wins}W / {analytics.losses}L
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Profit Factor</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              {analytics.profitFactor !== null ? analytics.profitFactor.toFixed(2) : '—'}
            </div>
            <div className="text-[11px] text-slate-400">
              Avg W ${fmtUsd(analytics.avgWinUnits)}
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Max Drawdown</div>
            <div className="mt-1 text-sm font-semibold text-rose-300">
              {analytics.maxDrawdownPct.toFixed(2)}%
            </div>
            <div className="text-[11px] text-slate-400">
              Sharpe-like {analytics.sharpeLike !== null ? analytics.sharpeLike.toFixed(2) : '—'}
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Net PnL</div>
            <div
              className={`mt-1 text-sm font-semibold ${
                stringToUnits(analytics.totalNetPnlUnits) >= 0n
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }`}
            >
              ${fmtUsd(analytics.totalNetPnlUnits)}
            </div>
            <div className="text-[11px] text-slate-400">
              Fees ${fmtUsd(analytics.totalFeesUnits)}
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#0B1120] p-2.5">
            <div className="font-sans text-[11px] text-slate-400">Slippage & Funding</div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              ${fmtUsd(analytics.totalSlippageUnits)}
            </div>
            <div className="text-[11px] text-slate-400">
              Fund ${fmtUsd(analytics.totalFundingUnits)}
            </div>
          </div>
        </div>
      )}

      {/* Breakdown tables */}
      {analytics && (analytics.byGuardrail.length > 0 || analytics.byScoreBucket.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="overflow-x-auto rounded border border-slate-800 bg-[#0B1120] p-3">
            <div className="mb-2 text-xs font-semibold text-slate-200">By Entry Guardrail</div>
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 font-sans text-[11px] text-slate-400">
                  <th className="py-1 pr-2">Decision</th>
                  <th className="py-1 pr-2">Trades</th>
                  <th className="py-1 pr-2">Win Rate</th>
                  <th className="py-1 text-right">Net PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {analytics.byGuardrail.map((b) => (
                  <tr key={b.bucket} className="h-8">
                    <td className="pr-2 font-sans text-slate-200">{b.bucket}</td>
                    <td className="pr-2">{b.tradeCount}</td>
                    <td className="pr-2">{fmtPct(b.winRate)}</td>
                    <td className="text-right">${fmtUsd(b.totalNetPnlUnits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded border border-slate-800 bg-[#0B1120] p-3">
            <div className="mb-2 text-xs font-semibold text-slate-200">By Signal Intensity Bucket</div>
            <table className="w-full text-left text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-slate-800 font-sans text-[11px] text-slate-400">
                  <th className="py-1 pr-2">Bucket</th>
                  <th className="py-1 pr-2">Trades</th>
                  <th className="py-1 pr-2">Win Rate</th>
                  <th className="py-1 text-right">Net PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {analytics.byScoreBucket.map((b) => (
                  <tr key={b.bucket} className="h-8">
                    <td className="pr-2 font-sans text-slate-200">{b.bucket}</td>
                    <td className="pr-2">{b.tradeCount}</td>
                    <td className="pr-2">{fmtPct(b.winRate)}</td>
                    <td className="text-right">${fmtUsd(b.totalNetPnlUnits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drift comparison */}
      {drift && (
        <div
          className={`rounded border px-3 py-2.5 text-xs ${
            drift.driftFlagged
              ? 'border-rose-500/40 bg-rose-950/25 text-rose-200'
              : 'border-slate-800 bg-[#0B1120] text-slate-300'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
            <span>
              Paper vs. Backtest Drift ({drift.liveTradeCount} live vs {drift.backtestTradeCount}{' '}
              backtest trades)
            </span>
            <span className="font-mono text-[11px] tabular-nums">
              Avg Cost: Live ${fmtUsd(drift.liveAvgCostUnits, 3)} vs BT $
              {fmtUsd(drift.backtestAvgCostUnits, 3)}
            </span>
          </div>
          {drift.driftReasons.length > 0 && (
            <p className="mt-1 text-[11px] opacity-90">{drift.driftReasons.join(' ')}</p>
          )}
        </div>
      )}
    </section>
  );
}
