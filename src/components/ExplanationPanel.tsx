import { useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Info,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import {
  EXPLAIN_SYSTEM_INSTRUCTION,
  type ExplainSnapshotRequest,
  type ExplainStatusResponse,
} from '../contracts/explain';
import { DISALLOWED_EXPLAIN_WORDS } from '../engine/explainGuard';
import { evaluateGuardrails } from '../engine/guardrails';
import type { RegimeSeriesResult } from '../engine/regime';
import { useExplanation } from '../hooks/useExplanation';
import { formatTimestamp } from '../utils/format';

interface ExplanationPanelProps {
  regimeResult: RegimeSeriesResult;
  sourceLabel: 'Delta' | 'Alpaca';
  timeframeLabel: string;
  symbol: string | null;
  explainStatus: ExplainStatusResponse | null;
  onAfterRequest?: () => void;
}

const NOT_CONFIGURED_MESSAGE =
  'Gemini not configured — set GEMINI_API_KEY in your server environment';

export function ExplanationPanel({
  regimeResult,
  sourceLabel,
  timeframeLabel,
  symbol,
  explainStatus,
  onAfterRequest,
}: ExplanationPanelProps) {
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const snapshot = useMemo<ExplainSnapshotRequest | null>(() => {
    if (!symbol) return null;

    const requiredBars = Math.max(
      regimeResult.meta.requiredBarsForVolZ,
      regimeResult.meta.requiredBarsForTrend,
    );
    const evaluation = evaluateGuardrails({
      score: regimeResult.latest.score,
      volZ: regimeResult.latest.volZ,
      trend: regimeResult.latest.trend,
      changePointsInWindow: regimeResult.latest.cusumCount,
      lastChangePointAgeBars: regimeResult.latest.barsSinceCusum,
      candleCount: regimeResult.meta.candleCount,
      requiredBars,
    });

    const { options } = regimeResult.meta;

    return {
      source: sourceLabel,
      symbol,
      timeframe: timeframeLabel,
      candleCount: regimeResult.meta.candleCount,
      lastCandleTime: regimeResult.latest.time,
      regime: {
        score: evaluation.inputs.score,
        volZ: evaluation.inputs.volZ,
        trend: evaluation.inputs.trend,
        changePointsInWindow: evaluation.inputs.changePointsInWindow,
        lastChangePointAgeBars: evaluation.inputs.lastChangePointAgeBars,
      },
      guardrail: {
        decision: evaluation.decision,
        firedRules: evaluation.firedRules,
        reasons: evaluation.reasons,
        thresholdsUsed: evaluation.thresholdsUsed,
      },
      windows: {
        volWindow: options.volWindow,
        volLookback: options.volLookback,
        trendWindow: options.trendWindow,
        cusumVolWindow: options.cusumVolWindow,
        cusumK: options.cusumK,
        cusumH: options.cusumH,
        cusumDecayBars: options.cusumDecayBars,
        weights: {
          volatility: options.weights.volatility,
          trend: options.weights.trend,
          cusum: options.weights.cusum,
        },
        requiredBarsForVolZ: regimeResult.meta.requiredBarsForVolZ,
        requiredBarsForTrend: regimeResult.meta.requiredBarsForTrend,
        requiredBarsForCusum: regimeResult.meta.requiredBarsForCusum,
        skippedNonPositiveCloses: regimeResult.meta.skippedNonPositiveCloses,
      },
    };
  }, [regimeResult, sourceLabel, timeframeLabel, symbol]);

  const {
    explanation,
    model,
    generatedAt,
    cached,
    isLoading,
    error,
    explain,
  } = useExplanation(snapshot, onAfterRequest);

  const isConfigured = explainStatus?.configured ?? null;
  const canExplain = Boolean(snapshot) && isConfigured !== false && !isLoading;

  const isBlockedGuardError =
    error?.code === 'UNGROUNDED_OUTPUT' || error?.code === 'DISALLOWED_CONTENT';

  return (
    <section
      aria-label="Gemini Structured Explanation"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Required AI Advisory Label */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-[#0B1120]/70 px-5 py-2 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-sky-400" aria-hidden="true" />
          <span>
            AI-generated description of the numbers above. Advisory only. Not financial advice. This app does not place orders.
          </span>
        </div>
      </div>

      {/* Header + Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3.5">
        <div className="space-y-0.5">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Structured Metric Explanation
          </h2>
          <p className="text-[11px] text-slate-400">
            Manual narration of the loaded regime and guardrail numbers only
            {symbol ? (
              <>
                {' '}
                · <span className="font-mono text-slate-300">{symbol}</span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={showHowItWorks}
            onClick={() => setShowHowItWorks((prev) => !prev)}
            className="flex items-center gap-1.5 rounded-md border border-slate-800 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 cursor-pointer transition-colors duration-150"
          >
            {showHowItWorks ? (
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            )}
            <span>How this works</span>
          </button>

          <button
            type="button"
            onClick={() => void explain()}
            disabled={!canExplain}
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-950/40 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-900/40 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isLoading ? 'Explaining…' : 'Explain these numbers'}</span>
          </button>
        </div>
      </div>

      {/* Body Area */}
      <div className="px-5 py-4 space-y-4">
        {isConfigured === false && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-md border border-slate-700/80 bg-[#0B1120]/80 px-4 py-3 text-xs text-slate-300"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <span>{NOT_CONFIGURED_MESSAGE}</span>
          </div>
        )}

        {isLoading && (
          <div aria-label="Loading structured explanation" className="space-y-3">
            <div className="h-4 w-5/6 animate-pulse rounded bg-slate-800" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
            <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, idx) => (
                <div key={idx} className="h-20 animate-pulse rounded border border-slate-800 bg-[#0B1120]/70" />
              ))}
            </div>
          </div>
        )}

        {!isLoading && error && (
          <div
            role="alert"
            className="rounded-md border border-rose-500/35 bg-rose-950/25 p-4 text-xs text-rose-200 space-y-1.5"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="space-y-1 min-w-0">
                <p className="font-medium text-rose-100">
                  {isBlockedGuardError
                    ? 'Explanation output was blocked by server safety checks'
                    : 'Unable to generate explanation'}
                  {error.status !== null ? ` (HTTP ${error.status})` : ''}
                </p>
                <p className="text-rose-300/90 break-words">
                  [{error.code}] {error.message}
                </p>
                {error.offendingNumbers && error.offendingNumbers.length > 0 && (
                  <p className="font-mono text-[11px] text-rose-300">
                    Offending numbers blocked: {error.offendingNumbers.join(', ')}
                  </p>
                )}
                {error.matchedWords && error.matchedWords.length > 0 && (
                  <p className="font-mono text-[11px] text-rose-300">
                    Disallowed words blocked: {error.matchedWords.join(', ')}
                  </p>
                )}
                <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                  Timestamp: {formatTimestamp(error.timestamp)}
                </p>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && !explanation && isConfigured !== false && (
          <p className="text-xs text-slate-400">
            {symbol
              ? `Click "Explain these numbers" to send the current ${symbol} regime and guardrail snapshot (${regimeResult.meta.candleCount} candles) to the server-side Gemini endpoint.`
              : 'Select an instrument to enable structured explanation for its computed numbers.'}
          </p>
        )}

        {!isLoading && !error && explanation && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="rounded-md border border-slate-800/90 bg-[#0B1120]/80 px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                Summary
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-100">
                {explanation.summary}
              </p>
            </div>

            {/* Key Points */}
            {explanation.keyPoints.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Key Points
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {explanation.keyPoints.map((kp, idx) => (
                    <div
                      key={`${kp.label}-${idx}`}
                      className="rounded-md border border-slate-800/90 bg-[#0B1120]/70 px-3.5 py-3 space-y-1"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[11px] font-medium text-slate-400">
                          {kp.label}
                        </span>
                        <span className="font-mono text-xs font-semibold text-sky-300 tabular-nums">
                          {kp.valueText}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-slate-200">{kp.meaning}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Cautions & Unavailable */}
            {(explanation.cautions.length > 0 || explanation.unavailable.length > 0) && (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {explanation.cautions.length > 0 && (
                  <div className="rounded-md border border-amber-500/25 bg-amber-950/15 px-4 py-3 space-y-1.5">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-amber-300/90">
                      Cautions
                    </div>
                    <ul className="list-disc pl-4 space-y-1 text-xs text-amber-100/90">
                      {explanation.cautions.map((caution, idx) => (
                        <li key={idx}>{caution}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {explanation.unavailable.length > 0 && (
                  <div className="rounded-md border border-slate-800/90 bg-[#0B1120]/70 px-4 py-3 space-y-1.5">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Unavailable Metrics
                    </div>
                    <ul className="list-disc pl-4 space-y-1 font-mono text-xs text-slate-300">
                      {explanation.unavailable.map((item, idx) => (
                        <li key={idx}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible How This Works */}
      {showHowItWorks && (
        <div className="border-t border-slate-800/80 bg-[#0B1120]/80 px-5 py-4 text-xs text-slate-300 space-y-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Server System Instruction Constant
            </p>
            <p className="mt-1.5 rounded border border-slate-800 bg-[#111A2E]/70 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
              {EXPLAIN_SYSTEM_INSTRUCTION}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Server Validation &amp; Grounding Guardrails
            </p>
            <ul className="list-disc pl-4 space-y-1 text-[11px] text-slate-300">
              <li>
                Every numeric token in summary, key points, cautions, and unavailable entries must match a value (within decimal display rounding) in the live snapshot JSON, or HTTP 502 <span className="font-mono">UNGROUNDED_OUTPUT</span> blocks the response.
              </li>
              <li>
                Case-insensitive word filter blocks output containing:{' '}
                <span className="font-mono text-slate-200">
                  {DISALLOWED_EXPLAIN_WORDS.join(', ')}
                </span>{' '}
                with HTTP 502 <span className="font-mono">DISALLOWED_CONTENT</span>.
              </li>
              <li>
                Manual trigger only; 60s server SHA-256 snapshot cache and 10 requests/minute per-IP rate limit.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Provenance Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 font-mono text-[11px] text-slate-400 tabular-nums">
        <span>
          Model: {model ?? '—'} · Generated: {formatTimestamp(generatedAt)}
          {cached ? ' (cached)' : ''} · Based on {regimeResult.meta.candleCount} candles · Source:{' '}
          {sourceLabel} · {timeframeLabel}
        </span>
      </div>
    </section>
  );
}
