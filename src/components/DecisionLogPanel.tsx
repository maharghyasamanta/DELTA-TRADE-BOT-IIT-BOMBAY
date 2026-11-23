import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { AlertCircle, LogIn, RefreshCw, Trash2 } from 'lucide-react';
import {
  deleteDecisionLogEntry,
  fetchDecisionLog,
  subscribeToDecisionLog,
  type DecisionLogRecord,
} from '../services/decisionLogService';
import { formatTimestamp } from '../utils/format';

interface DecisionLogPanelProps {
  user: User | null;
  authReady: boolean;
  isFirebaseConfigured: boolean;
  firebaseConfigError: string | null;
  onSignIn: () => void;
}

function decisionPillClass(decision: DecisionLogRecord['decision']): string {
  switch (decision) {
    case 'CONTINUE':
      return 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40';
    case 'REDUCE_SIZE':
      return 'text-amber-300 border-amber-500/40 bg-amber-950/40';
    case 'PAUSE':
      return 'text-rose-300 border-rose-500/40 bg-rose-950/40';
    case 'NO_DECISION':
      return 'text-slate-300 border-slate-700 bg-slate-900';
  }
}

export function DecisionLogPanel({
  user,
  authReady,
  isFirebaseConfigured,
  firebaseConfigError,
  onSignIn,
}: DecisionLogPanelProps) {
  const [records, setRecords] = useState<DecisionLogRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ message: string; timestamp: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !authReady || !user) {
      setRecords([]);
      setIsLoading(false);
      setError(null);
      setConfirmDeleteId(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const unsubscribe = subscribeToDecisionLog(
      user.uid,
      (nextRecords) => {
        setRecords(nextRecords);
        setIsLoading(false);
        setError(null);
      },
      (err) => {
        setIsLoading(false);
        setError({
          message: err.message,
          timestamp: new Date().toISOString(),
        });
      },
    );

    return () => unsubscribe();
  }, [user, authReady, isFirebaseConfigured]);

  const handleManualRefresh = useCallback(async () => {
    if (!user || !isFirebaseConfigured) return;
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchDecisionLog(user.uid);
      setRecords(next);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to refresh decision log',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsLoading(false);
    }
  }, [user, isFirebaseConfigured]);

  const handleConfirmDelete = useCallback(
    async (docId: string) => {
      if (!user || !isFirebaseConfigured) return;
      setDeletingId(docId);
      setError(null);
      try {
        await deleteDecisionLogEntry(user.uid, docId);
        setConfirmDeleteId(null);
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : 'Failed to delete entry',
          timestamp: new Date().toISOString(),
        });
      } finally {
        setDeletingId(null);
      }
    },
    [user, isFirebaseConfigured],
  );

  return (
    <section
      id="decision-log"
      aria-label="Firestore Decision Log"
      className="rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3.5">
        <div>
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Advisory Decision Log
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Last 50 logged advisory evaluations per authenticated user (users/&#123;uid&#125;/decisions)
          </p>
        </div>

        {user && isFirebaseConfigured && (
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        )}
      </div>

      <div className="p-5">
        {!isFirebaseConfigured ? (
          <div className="rounded-md border border-slate-800 bg-[#0B1120] p-4 text-xs text-slate-300 space-y-1">
            <p className="font-medium text-slate-100">Firebase Firestore not configured</p>
            <p className="text-slate-400">
              {firebaseConfigError ??
                'Provide firebase-applet-config.json or VITE_FIREBASE_* variables and deploy firestore.rules to enable user decision logging.'}
            </p>
          </div>
        ) : !authReady ? (
          <div className="rounded-md border border-slate-800 bg-[#0B1120] p-4 font-mono text-xs text-slate-400">
            Checking authentication status…
          </div>
        ) : !user ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 bg-[#0B1120] p-4 text-xs text-slate-300">
            <span>
              Sign in with Google to persist advisory guardrail snapshots to your private Firestore
              log and review the last 50 entries.
            </span>
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-950/30 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer"
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Sign in with Google</span>
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-950/25 p-3 text-xs text-rose-200"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div className="space-y-0.5 font-mono">
                  <div>{error.message}</div>
                  <div className="text-[11px] text-rose-400/80">
                    At {formatTimestamp(error.timestamp)}
                  </div>
                </div>
              </div>
            )}

            {isLoading && records.length === 0 ? (
              <div className="py-6 text-center font-mono text-xs text-slate-400">
                Loading logged decisions from Firestore…
              </div>
            ) : records.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400">
                No decisions logged yet. Use &ldquo;Log this decision&rdquo; in the guardrail panel
                above to record an advisory snapshot.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                      <th className="py-2 pr-4 font-medium">Logged At</th>
                      <th className="py-2 pr-4 font-medium">Source</th>
                      <th className="py-2 pr-4 font-medium">Symbol</th>
                      <th className="py-2 pr-4 font-medium">Window</th>
                      <th className="py-2 pr-4 font-medium">Decision</th>
                      <th className="py-2 pr-4 font-medium">Fired Rules &amp; Reasons</th>
                      <th className="py-2 pr-4 font-medium text-right">Bars</th>
                      <th className="py-2 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
                    {records.map((entry) => (
                      <tr key={entry.id} className="align-top hover:bg-slate-900/40">
                        <td className="py-2.5 pr-4 whitespace-nowrap text-slate-300">
                          {entry.timestampIso
                            ? entry.timestampIso.replace('T', ' ').slice(0, 19) + ' UTC'
                            : 'Pending…'}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap text-slate-300">
                          {entry.source}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap font-semibold text-slate-100">
                          {entry.symbol}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap text-slate-300">
                          {entry.timeframe}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap">
                          <span
                            className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${decisionPillClass(
                              entry.decision,
                            )}`}
                          >
                            {entry.decision}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 text-[11px] text-slate-300 max-w-md">
                          <div className="text-slate-200">{entry.firedRules.join(', ')}</div>
                          <div className="mt-0.5 text-slate-400">
                            {entry.reasons.join(' · ')}
                          </div>
                        </td>
                        <td className="py-2.5 pr-4 text-right whitespace-nowrap text-slate-300">
                          {entry.candleCount}
                        </td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          {confirmDeleteId === entry.id ? (
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={deletingId === entry.id}
                                onClick={() => void handleConfirmDelete(entry.id)}
                                className="rounded border border-rose-500/50 bg-rose-950/50 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/50 cursor-pointer disabled:opacity-50"
                              >
                                {deletingId === entry.id ? 'Deleting…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:text-slate-100 cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete decision ${entry.id}`}
                              onClick={() => setConfirmDeleteId(entry.id)}
                              className="inline-flex items-center gap-1 rounded border border-slate-800 px-2 py-0.5 text-[11px] text-slate-400 hover:border-rose-500/40 hover:text-rose-300 cursor-pointer"
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                              <span>Delete</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
