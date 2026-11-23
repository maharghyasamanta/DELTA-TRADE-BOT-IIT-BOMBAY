import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  BookmarkPlus,
  CheckCircle2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { evaluateGuardrails, type GuardrailDecision } from '../engine/guardrails';
import type { RegimeSeriesResult } from '../engine/regime';
import { formatFirestoreErrorForUi } from '../firebase';
import {
  logGuardrailDecision,
  type DecisionSource,
} from '../services/decisionLogService';
import { formatTimestamp } from '../utils/format';

interface GuardrailPanelProps {
  regimeResult: RegimeSeriesResult;
  sourceLabel: DecisionSource;
  timeframeLabel: string;
  symbol: string | null;
  user: User | null;
  authReady?: boolean;
  isFirebaseConfigured: boolean;
  onSignIn: () => void;
}

function formatUtcCandleTime(unixSec: number | null): string {
  if (unixSec === null || !Number.isFinite(unixSec)) return '—';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function decisionBadgeStyle(decision: GuardrailDecision): {
  label: string;
  className: string;
} {
  switch (decision) {
    case 'CONTINUE':
      return {
        label: 'CONTINUE',
        className: 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300',
      };
    case 'REDUCE_SIZE':
      return {
        label: 'REDUCE_SIZE',
        className: 'border-amber-500/40 bg-amber-950/50 text-amber-300',
      };
    case 'PAUSE':
      return {
        label: 'PAUSE',
        className: 'border-rose-500/40 bg-rose-950/50 text-rose-300',
      };
    case 'NO_DECISION':
      return {
        label: 'NO_DECISION',
        className: 'border-slate-700 bg-slate-900/90 text-slate-300',
      };
  }
}

export function GuardrailPanel({
  regimeResult,
  sourceLabel,
  timeframeLabel,
  symbol,
  user,
  authReady = true,
  isFirebaseConfigured,
  onSignIn,
}: GuardrailPanelProps) {
  const [isLogging, setIsLogging] = useState(false);
  const [logStatus, setLogStatus] = useState<{
    kind: 'success' | 'error';
    message: string;
    timestamp: string;
  } | null>(null);

  const requiredBars = Math.max(
    regimeResult.meta.requiredBarsForVolZ,
    regimeResult.meta.requiredBarsForTrend,
  );

  const evaluation = useMemo(
    () =>
      evaluateGuardrails({
        score: regimeResult.latest.score,
        volZ: regimeResult.latest.volZ,
        trend: regimeResult.latest.trend,
        changePointsInWindow: regimeResult.latest.cusumCount,
        lastChangePointAgeBars: regimeResult.latest.barsSinceCusum,
        candleCount: regimeResult.meta.candleCount,
        requiredBars,
      }),
    [regimeResult, requiredBars],
  );

  // Clear stale log feedback whenever context changes
  useEffect(() => {
    setLogStatus(null);
  }, [sourceLabel, symbol, timeframeLabel]);

  const badge = decisionBadgeStyle(evaluation.decision);
  const { thresholdsUsed } = evaluation;

  async function handleLogDecision() {
    if (!user || !symbol || !isFirebaseConfigured) return;
    setIsLogging(true);
    setLogStatus(null);
    try {
      const docId = await logGuardrailDecision(user.uid, {
        source: sourceLabel,
        symbol,
        timeframe: timeframeLabel,
        decision: evaluation.decision,
        firedRules: evaluation.firedRules,
        reasons: evaluation.reasons,
        inputs: evaluation.inputs,
        thresholdsUsed: evaluation.thresholdsUsed,
        lastCandleTime: regimeResult.latest.time,
        candleCount: regimeResult.meta.candleCount,
      });
      setLogStatus({
        kind: 'success',
        message: `Logged decision (${docId})`,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const formatted = formatFirestoreErrorForUi(err);
      setLogStatus({
        kind: 'error',
        message: formatted.code ? `[${formatted.code}] ${formatted.message}` : formatted.message,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsLogging(false);
    }
  }

  return (
    <section
      aria-label="Deterministic Guardrail Rules"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Prominent Advisory Banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-950/25 px-5 py-2 text-xs text-amber-200">
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <span>Advisory only. Not financial advice. This app does not place orders.</span>
        </div>
        <span className="font-mono text-[11px] text-amber-300/80">
          Read-only rule evaluation
        </span>
      </div>

      {/* Header + Decision Badge + Log Button */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Deterministic Guardrail Evaluation
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Computed strictly from loaded descriptive signal metrics
              {symbol ? (
                <>
                  {' '}
                  · <span className="font-mono text-slate-300">{symbol}</span>
                </>
              ) : null}
            </p>
          </div>

          <span
            data-testid="guardrail-decision-badge"
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1 font-mono text-xs font-semibold tracking-wide ${badge.className}`}
          >
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{badge.label}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!authReady && isFirebaseConfigured ? (
            <span className="font-mono text-[11px] text-slate-400">
              Checking auth…
            </span>
          ) : user && isFirebaseConfigured ? (
            <button
              type="button"
              onClick={() => void handleLogDecision()}
              disabled={isLogging || !symbol}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-950/40 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer disabled:opacity-50"
            >
              <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{isLogging ? 'Logging…' : 'Log this decision'}</span>
            </button>
          ) : isFirebaseConfigured ? (
            <button
              type="button"
              onClick={onSignIn}
              className="rounded-md border border-slate-700 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-slate-100 cursor-pointer"
            >
              Sign in with Google to log
            </button>
          ) : (
            <span className="font-mono text-[11px] text-slate-400">
              Logging unavailable (Firebase unconfigured)
            </span>
          )}
        </div>
      </div>

      {/* Fired Rules & Thresholds Used */}
      <div className="grid grid-cols-1 gap-px bg-slate-800/70 lg:grid-cols-2">
        {/* Fired Rules / Reasons */}
        <div className="bg-[#111A2E] px-5 py-4 space-y-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Fired Rules &amp; Numeric Reasons
          </div>
          <ul className="space-y-2 font-mono text-xs">
            {evaluation.firedRules.map((ruleName, idx) => (
              <li
                key={ruleName}
                className="rounded border border-slate-800/90 bg-[#0B1120]/80 px-3 py-2"
              >
                <div className="text-[11px] font-semibold text-slate-300">{ruleName}</div>
                <div className="mt-0.5 text-slate-200 tabular-nums">
                  {evaluation.reasons[idx] ?? '—'}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Thresholds Used */}
        <div className="bg-[#111A2E] px-5 py-4 space-y-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
            Active Rule Thresholds
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs tabular-nums">
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-rose-300/90">PAUSE Score &gt;=</div>
              <div className="mt-0.5 text-slate-100">{thresholdsUsed.pauseScore}</div>
            </div>
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-amber-300/90">REDUCE Score &gt;=</div>
              <div className="mt-0.5 text-slate-100">{thresholdsUsed.reduceScore}</div>
            </div>
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-rose-300/90">PAUSE Vol Z &gt;=</div>
              <div className="mt-0.5 text-slate-100">+{thresholdsUsed.pauseVolZ.toFixed(2)}σ</div>
            </div>
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-amber-300/90">REDUCE Vol Z &gt;=</div>
              <div className="mt-0.5 text-slate-100">+{thresholdsUsed.reduceVolZ.toFixed(2)}σ</div>
            </div>
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-rose-300/90">PAUSE CP Age &lt;=</div>
              <div className="mt-0.5 text-slate-100">
                {thresholdsUsed.pauseChangePointAgeBars} bars
              </div>
            </div>
            <div className="rounded border border-slate-800/80 bg-[#0B1120]/70 px-3 py-2">
              <div className="text-[11px] text-amber-300/90">REDUCE CP Age &lt;=</div>
              <div className="mt-0.5 text-slate-100">
                {thresholdsUsed.reduceChangePointAgeBars} bars
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Log Operation Status */}
      {logStatus && (
        <div
          role={logStatus.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-center gap-2 border-t px-5 py-2.5 font-mono text-xs ${
            logStatus.kind === 'error'
              ? 'border-rose-500/30 bg-rose-950/25 text-rose-200'
              : 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
          }`}
        >
          {logStatus.kind === 'error' ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          )}
          <span>
            {logStatus.message} · At {formatTimestamp(logStatus.timestamp)}
          </span>
        </div>
      )}

      {/* Provenance Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 font-mono text-[11px] text-slate-400 tabular-nums">
        <span>
          Computed from {regimeResult.meta.candleCount} candles · Source: {sourceLabel} ·{' '}
          {timeframeLabel} · Last candle: {formatUtcCandleTime(regimeResult.latest.time)}
        </span>
      </div>
    </section>
  );
}
