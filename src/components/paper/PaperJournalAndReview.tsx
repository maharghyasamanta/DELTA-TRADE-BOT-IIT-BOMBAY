import { Sparkles } from 'lucide-react';
import type { ExplainClosedTradeResponse, PaperClosedTrade, PaperSessionState } from '../../contracts/paper';
import { formatFixedUnits, stringToUnits } from '../../engine/decimal';
import { formatTimestamp } from '../../utils/format';

interface PaperJournalAndReviewProps {
  session: PaperSessionState;
  tradeReviews: Record<string, ExplainClosedTradeResponse>;
  reviewingTradeId: string | null;
  onExplainTrade: (trade: PaperClosedTrade) => Promise<void>;
}

export function PaperJournalAndReview({
  session,
  tradeReviews,
  reviewingTradeId,
  onExplainTrade,
}: PaperJournalAndReviewProps) {
  const tickNum = Number(session.contract.tickSizeStr) || 0.5;
  const decimals = session.contract.tickSizeStr.includes('.')
    ? session.contract.tickSizeStr.split('.')[1].length
    : 0;
  const fmtTicks = (ticks: number) => (ticks * tickNum).toFixed(decimals);
  const fmtUsd = (units: string, d = 2) => formatFixedUnits(stringToUnits(units), d);

  const reviewEntries = Object.entries(tradeReviews);

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Simulated Trade Journal ({session.closedTrades.length})
          </h3>
          <p className="text-xs text-slate-400">
            Includes gross PnL, fees, slippage, funding, liquidation penalties, guardrail snapshots, and Gemini closed-trade audit
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">Closed</th>
              <th className="py-2 pr-3">Side / Qty</th>
              <th className="py-2 pr-3">Entry → Exit</th>
              <th className="py-2 pr-3">Reason</th>
              <th className="py-2 pr-3">Guardrail (In → Out)</th>
              <th className="py-2 pr-3">Fees / Slip / Fund</th>
              <th className="py-2 pr-3 text-right">Net PnL</th>
              <th className="py-2 text-right">Gemini Audit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
            {session.closedTrades.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-5 text-center font-sans text-slate-400">
                  No simulated trades closed yet.
                </td>
              </tr>
            ) : (
              session.closedTrades.map((t) => {
                const netUnits = stringToUnits(t.netPnlUnits);
                const review = tradeReviews[t.tradeId];
                const isReviewing = reviewingTradeId === t.tradeId;
                return (
                  <tr key={t.tradeId} className="h-10 text-slate-200">
                    <td className="pr-3 text-slate-400">
                      {formatTimestamp(new Date(t.closedAtSec * 1000).toISOString())}
                      {t.replayed && (
                        <span className="ml-1.5 rounded border border-amber-500/40 bg-amber-950/50 px-1 py-0.5 text-[10px] text-amber-300">
                          replayed
                        </span>
                      )}
                    </td>
                    <td className="pr-3">
                      <span className={t.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>
                        {t.side}
                      </span>{' '}
                      ×{t.contracts}
                    </td>
                    <td className="pr-3">
                      ${fmtTicks(t.entryPriceTicks)} → ${fmtTicks(t.exitPriceTicks)}
                    </td>
                    <td className="pr-3 font-sans text-slate-300">{t.exitReason}</td>
                    <td className="pr-3 font-sans text-slate-300">
                      {t.entryGuardrail.decision} → {t.exitGuardrail.decision}
                    </td>
                    <td className="pr-3 text-slate-400">
                      ${fmtUsd(t.totalFeesUnits, 3)} / ${fmtUsd(t.totalSlippageUnits, 3)} / $
                      {fmtUsd(t.fundingPnlUnits, 3)}
                    </td>
                    <td
                      className={`pr-3 text-right font-semibold ${
                        netUnits >= 0n ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {netUnits >= 0n ? '+' : ''}${fmtUsd(t.netPnlUnits, 3)}
                    </td>
                    <td className="text-right font-sans">
                      <button
                        type="button"
                        onClick={() => void onExplainTrade(t)}
                        disabled={Boolean(reviewingTradeId)}
                        className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-950/40 px-2 py-1 text-[11px] font-medium text-sky-200 hover:bg-sky-900/50 disabled:opacity-50 cursor-pointer"
                      >
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                        {isReviewing ? 'Reviewing...' : review ? 'Reviewed' : 'Explain'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {reviewEntries.length > 0 && (
        <div className="space-y-3 border-t border-slate-800/80 pt-3">
          {reviewEntries.map(([tradeId, review]) => (
            <div
              key={tradeId}
              className="rounded border border-slate-800 bg-[#0B1120] p-3 text-xs space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-sky-300">
                  Gemini Trade Review · {tradeId}
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {review.model} {review.cached ? '· cached' : ''}
                </span>
              </div>
              <p className="text-slate-200 leading-relaxed">{review.explanation.summary}</p>
              {review.explanation.keyPoints.length > 0 && (
                <ul className="space-y-1 text-[11px] text-slate-300">
                  {review.explanation.keyPoints.map((kp, i) => (
                    <li key={i}>
                      <span className="font-semibold text-slate-100">{kp.label}:</span>{' '}
                      <span className="font-mono text-sky-300">{kp.valueText}</span> — {kp.meaning}
                    </li>
                  ))}
                </ul>
              )}
              {review.explanation.cautions.length > 0 && (
                <p className="text-[11px] text-amber-300">
                  Caveats: {review.explanation.cautions.join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
