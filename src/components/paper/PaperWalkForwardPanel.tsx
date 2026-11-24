import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Eye } from 'lucide-react';
import type {
  HeldOutEvaluationLog,
  PaperParameterVersion,
  PaperSessionState,
  WalkForwardReport,
  WalkForwardSplitSummary,
} from '../../contracts/paper';

interface PaperWalkForwardPanelProps {
  session: PaperSessionState;
  busyAction: string | null;
  report: WalkForwardReport | null;
  heldOutResult: { summary: WalkForwardSplitSummary; log: HeldOutEvaluationLog } | null;
  onRunWalkForward: (fixedHalfSpreadTicks: number, lookbackBars: number) => Promise<void>;
  onEvaluateHeldOut: (version: PaperParameterVersion, lookbackBars: number) => Promise<void>;
  onActivateVersion: (version: PaperParameterVersion) => Promise<void>;
}

export function PaperWalkForwardPanel({
  session,
  busyAction,
  report,
  heldOutResult,
  onRunWalkForward,
  onEvaluateHeldOut,
  onActivateVersion,
}: PaperWalkForwardPanelProps) {
  const [halfSpreadTicks, setHalfSpreadTicks] = useState(
    String(session.activeVersion.fixedHalfSpreadTicks || 2),
  );
  const [lookbackBars, setLookbackBars] = useState('720');

  const inspectionCount = session.account.heldOutInspectionCount;

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Walk-Forward Parameter Search (3-Split Worker Thread)
          </h3>
          <p className="text-xs text-slate-400">
            50% In-Sample · 25% Out-of-Sample · 25% Untouched Held-Out · Max 1 concurrent search per user
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
            Half-Spread (ticks)
            <input
              type="number"
              min={1}
              max={50}
              value={halfSpreadTicks}
              onChange={(e) => setHalfSpreadTicks(e.target.value)}
              className="w-16 rounded border border-slate-700 bg-[#0B1120] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
            Bars
            <input
              type="number"
              min={240}
              max={2400}
              step={80}
              value={lookbackBars}
              onChange={(e) => setLookbackBars(e.target.value)}
              className="w-20 rounded border border-slate-700 bg-[#0B1120] px-2 py-1 font-mono text-xs text-slate-100 tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void onRunWalkForward(
                Math.max(1, Math.floor(Number(halfSpreadTicks) || 2)),
                Math.min(2400, Math.max(240, Math.floor(Number(lookbackBars) || 720))),
              )
            }
            disabled={Boolean(busyAction)}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/50 bg-sky-600/20 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-600/30 disabled:opacity-50 cursor-pointer"
          >
            <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
            Run Worker Search
          </button>
        </div>
      </div>

      {inspectionCount >= 1 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded border border-amber-500/50 bg-amber-950/35 px-3 py-2 text-xs text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div>
            <span className="font-semibold">
              Held-Out Set Inspected {inspectionCount} {inspectionCount === 1 ? 'Time' : 'Times'}:
            </span>{' '}
            {inspectionCount > 1
              ? 'Multiple looks at the held-out split weaken statistical validity (data-snooping bias). Only treat the very first held-out check as unbiased.'
              : 'Your single-look held-out budget has been used for this session. Any additional evaluation will degrade statistical validity.'}
          </div>
        </div>
      )}

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
            <span>
              Evaluated <span className="font-mono text-slate-100">{report.evaluatedCandidates}</span>{' '}
              grid combinations on <span className="font-mono">{report.totalBars}</span> bars (half-spread{' '}
              <span className="font-mono">{report.fixedHalfSpreadTicks}t</span>).
            </span>
            {report.bestCandidate ? (
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Promoted best OOS candidate: {report.bestCandidate.label}
              </span>
            ) : (
              <span className="text-amber-300">
                No candidate cleared the Out-of-Sample gate — baseline preserved.
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-3">Candidate</th>
                  <th className="py-2 pr-3">In-Sample (50%)</th>
                  <th className="py-2 pr-3">Out-of-Sample (25%)</th>
                  <th className="py-2 pr-3">Gate Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                {[report.baselineCandidate, ...report.candidates.slice(0, 6)].map((c) => {
                  const isActive = session.activeVersion.versionId === c.version.versionId;
                  return (
                    <tr key={c.candidateId} className="h-10 text-slate-200">
                      <td className="pr-3 font-sans">{c.label}</td>
                      <td className="pr-3">
                        {c.inSample.netReturnPct >= 0 ? '+' : ''}
                        {c.inSample.netReturnPct.toFixed(2)}% ({c.inSample.tradeCount}t)
                      </td>
                      <td className="pr-3">
                        {c.outOfSample.netReturnPct >= 0 ? '+' : ''}
                        {c.outOfSample.netReturnPct.toFixed(2)}% ({c.outOfSample.tradeCount}t · PF{' '}
                        {c.outOfSample.profitFactor !== null
                          ? c.outOfSample.profitFactor.toFixed(2)
                          : '—'}
                        )
                      </td>
                      <td className="pr-3 font-sans">
                        {c.promoted ? (
                          <span className="text-emerald-400">Passed OOS Gate</span>
                        ) : (
                          <span className="text-slate-400">{c.rejectionReason}</span>
                        )}
                      </td>
                      <td className="text-right font-sans space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void onActivateVersion(c.version)}
                          disabled={Boolean(busyAction) || isActive || (!c.promoted && c.candidateId !== 'baseline')}
                          className="rounded border border-slate-700 bg-[#0B1120] px-2 py-1 text-[11px] text-slate-200 hover:border-sky-500/50 disabled:opacity-40 cursor-pointer"
                        >
                          {isActive ? 'Active' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void onEvaluateHeldOut(
                              c.version,
                              Math.min(2400, Math.max(240, Math.floor(Number(lookbackBars) || 720))),
                            )
                          }
                          disabled={Boolean(busyAction)}
                          className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/50 disabled:opacity-40 cursor-pointer"
                        >
                          <Eye className="h-3 w-3" aria-hidden="true" />
                          Inspect Held-Out
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {heldOutResult && (
        <div className="rounded border border-slate-800 bg-[#0B1120] p-3 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-100">
              Held-Out Audit Result (Inspection #{heldOutResult.log.inspectionIndex})
            </span>
            <span className="font-mono text-slate-400 tabular-nums">
              {heldOutResult.summary.barCount} bars · {heldOutResult.summary.tradeCount} trades
            </span>
          </div>
          <div className="font-mono text-slate-200 tabular-nums">
            Return: {heldOutResult.summary.netReturnPct >= 0 ? '+' : ''}
            {heldOutResult.summary.netReturnPct.toFixed(2)}% · Max DD:{' '}
            {heldOutResult.summary.maxDrawdownPct.toFixed(2)}% · Win Rate:{' '}
            {heldOutResult.summary.winRate !== null
              ? `${(heldOutResult.summary.winRate * 100).toFixed(1)}%`
              : '—'}
          </div>
        </div>
      )}
    </section>
  );
}
