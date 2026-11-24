import { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Play,
  ShieldAlert,
} from 'lucide-react';
import type { AlpacaFeed } from '../contracts/alpaca';
import type { CandlePriceBasis } from '../contracts/delta';
import {
  DEFAULT_CIRCULAR_SHIFT_PERCENTS,
  DEFAULT_EVENT_HORIZON_BARS,
  DEFAULT_EVENT_SIGMA_K,
  DEFAULT_LEAD_LOOKBACK_BARS,
  DEFAULT_MIN_SAMPLE_EPISODES,
  DEFAULT_MIN_SAMPLE_EVENTS,
  DEFAULT_SPIKE_MIN_RETURN_SAMPLES,
  DEFAULT_SPIKE_VOL_LOOKBACK_BARS,
  type BaselineRangeStats,
  type DetectorEvaluationReport,
  type DetectorMetricsBlock,
  type LeadTimeSummary,
  type WilsonInterval,
} from '../engine/evaluation';
import {
  DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS,
  DEFAULT_PAUSE_SCORE,
  DEFAULT_PAUSE_VOL_Z,
  DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS,
  DEFAULT_REDUCE_SCORE,
  DEFAULT_REDUCE_VOL_Z,
} from '../engine/guardrails';
import {
  DEFAULT_CUSUM_DECAY_BARS,
  DEFAULT_CUSUM_H,
  DEFAULT_CUSUM_K,
  DEFAULT_CUSUM_VOL_WINDOW,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_TREND_WINDOW,
  DEFAULT_VOL_LOOKBACK,
  DEFAULT_VOL_WINDOW,
} from '../engine/regime';
import {
  ALPACA_EVALUATION_WINDOWS,
  DELTA_EVALUATION_WINDOWS,
  EVALUATION_MAX_TOTAL_BARS,
  useEvaluationHistory,
  type EvaluationSource,
  type EvaluationTimeframe,
} from '../hooks/useEvaluationHistory';
import { formatTimestamp } from '../utils/format';

interface EvaluationPanelProps {
  source: EvaluationSource;
  symbol: string | null;
  basis?: CandlePriceBasis;
  alpacaFeed?: AlpacaFeed;
  alpacaConfigured?: boolean | null;
  onAfterAlpacaRequest?: () => void;
  onEvaluationStateChange?: (state: {
    completed: boolean;
    errorMessage: string | null;
    summaryDetail: string | null;
  }) => void;
}

function formatUtcMinute(unixSec: number | null): string {
  if (unixSec === null || !Number.isFinite(unixSec)) return '—';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatPct(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'Insufficient sample';
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatWilson(ci: WilsonInterval | null): string {
  if (!ci) return '—';
  return `[${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`;
}

function formatBaseline(stats: BaselineRangeStats | null): string {
  if (!stats) return '—';
  return `Mean ${(stats.mean * 100).toFixed(1)}% (${(stats.min * 100).toFixed(1)}%–${(stats.max * 100).toFixed(1)}%)`;
}

function formatLeadSummary(summary: LeadTimeSummary | null, unit: string): string {
  if (!summary) return '—';
  return `${summary.median.toFixed(1)} ${unit} (IQR ${summary.iqr.toFixed(1)}; Q25 ${summary.q25.toFixed(1)}–Q75 ${summary.q75.toFixed(1)})`;
}

function MetricsCell({
  block,
  metric,
}: {
  block: DetectorMetricsBlock;
  metric: 'recall' | 'precision';
}) {
  if (block.insufficientSample) {
    return (
      <div className="space-y-0.5">
        <div className="font-mono text-xs font-medium text-amber-300">
          Insufficient sample
        </div>
        <div className="font-mono text-[11px] text-slate-400">
          {metric === 'recall'
            ? `${block.hits}/${block.eventCount} hits`
            : `${block.trueEpisodes}/${block.alertEpisodeCount} true eps`}
        </div>
      </div>
    );
  }

  const ratio = metric === 'recall' ? block.recall : block.precision;
  const ci = metric === 'recall' ? block.wilsonRecall95 : block.wilsonPrecision95;
  const baselineStats =
    metric === 'recall' ? block.baseline?.recall ?? null : block.baseline?.precision ?? null;
  const countLabel =
    metric === 'recall'
      ? `${block.hits}/${block.eventCount} events hit`
      : `${block.trueEpisodes}/${block.alertEpisodeCount} episodes matched`;

  return (
    <div className="space-y-1 font-mono text-xs tabular-nums">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-slate-100">{formatPct(ratio)}</span>
        <span className="text-[11px] text-slate-400">{countLabel}</span>
      </div>
      <div className="text-[11px] text-sky-300/90">
        Wilson 95% (assumes independent trials, likely too narrow): {formatWilson(ci)}
      </div>
      <div className="text-[11px] text-slate-400">
        Shift baseline: {formatBaseline(baselineStats)}
      </div>
    </div>
  );
}

function EvaluationMetricsTable({
  title,
  subtitle,
  whole,
  firstHalf,
  secondHalf,
  testIdPrefix,
}: {
  title: string;
  subtitle: string;
  whole: DetectorMetricsBlock;
  firstHalf: DetectorMetricsBlock;
  secondHalf: DetectorMetricsBlock;
  testIdPrefix: string;
}) {
  const columns = [
    { key: 'whole', label: 'Whole History', block: whole },
    { key: 'firstHalf', label: 'First Half', block: firstHalf },
    { key: 'secondHalf', label: 'Second Half', block: secondHalf },
  ] as const;

  return (
    <div
      data-testid={testIdPrefix}
      className="rounded-md border border-slate-800/90 bg-[#0B1120]/70 overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-2.5">
        <div>
          <h3 className="font-display text-xs font-semibold text-slate-100">{title}</h3>
          <p className="text-[11px] text-slate-400">{subtitle}</p>
        </div>
        {(whole.insufficientSample ||
          firstHalf.insufficientSample ||
          secondHalf.insufficientSample) && (
          <span className="rounded border border-amber-500/35 bg-amber-950/30 px-2 py-0.5 font-mono text-[11px] text-amber-200">
            Below {DEFAULT_MIN_SAMPLE_EVENTS}-event / {DEFAULT_MIN_SAMPLE_EPISODES}-episode floor in ≥1 split
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800/80 bg-[#0B1120]/90 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="px-4 py-2.5 font-medium">Measurement</th>
              {columns.map((col) => (
                <th key={col.key} className="px-4 py-2.5 font-medium">
                  <div>{col.label}</div>
                  <div className="mt-0.5 font-mono text-[10px] font-normal normal-case text-slate-500 tabular-nums">
                    {col.block.barCount} bars · {col.block.eventCount} events ·{' '}
                    {col.block.alertEpisodeCount} episodes
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            <tr>
              <th scope="row" className="px-4 py-3 align-top font-medium text-slate-300">
                <div>Recall (hits / events)</div>
                <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                  With Wilson 95% CI (assumes independent trials, likely too narrow) &amp; circular-shift baseline
                </div>
              </th>
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-3 align-top">
                  <MetricsCell block={col.block} metric="recall" />
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className="px-4 py-3 align-top font-medium text-slate-300">
                <div>Precision (true episodes / episodes)</div>
                <div className="mt-0.5 text-[11px] font-normal text-slate-500">
                  With Wilson 95% CI (assumes independent trials, likely too narrow) &amp; circular-shift baseline
                </div>
              </th>
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-3 align-top">
                  <MetricsCell block={col.block} metric="precision" />
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className="px-4 py-2.5 align-top font-medium text-slate-300">
                False alarms / 100 bars
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-4 py-2.5 align-top font-mono text-xs text-slate-200 tabular-nums"
                >
                  {col.block.insufficientSample || col.block.falseAlarmsPer100Bars === null ? (
                    <span className="text-amber-300">
                      Insufficient sample ({col.block.falseAlarms} false eps)
                    </span>
                  ) : (
                    <span>
                      {col.block.falseAlarmsPer100Bars.toFixed(2)}{' '}
                      <span className="text-slate-400">
                        ({col.block.falseAlarms}/{col.block.barCount} bars)
                      </span>
                    </span>
                  )}
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className="px-4 py-2.5 align-top font-medium text-slate-300">
                Lead time (bars)
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-4 py-2.5 align-top font-mono text-xs text-slate-200 tabular-nums"
                >
                  {col.block.insufficientSample ? (
                    <span className="text-amber-300">Insufficient sample</span>
                  ) : (
                    formatLeadSummary(col.block.leadTimeBars, 'bars')
                  )}
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className="px-4 py-2.5 align-top font-medium text-slate-300">
                Lead time (minutes)
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-4 py-2.5 align-top font-mono text-xs text-slate-200 tabular-nums"
                >
                  {col.block.insufficientSample ? (
                    <span className="text-amber-300">Insufficient sample</span>
                  ) : (
                    formatLeadSummary(col.block.leadTimeMinutes, 'min')
                  )}
                </td>
              ))}
            </tr>

            <tr>
              <th scope="row" className="px-4 py-2.5 align-top font-medium text-slate-300">
                Counts (alert bars / missed events)
              </th>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-4 py-2.5 align-top font-mono text-[11px] text-slate-300 tabular-nums"
                >
                  {col.block.alertBarCount} alert bars · {col.block.missedEvents} missed events ·{' '}
                  {col.block.falseAlarms} false episodes
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function EvaluationPanel({
  source,
  symbol,
  basis = 'trade',
  alpacaFeed,
  alpacaConfigured = null,
  onAfterAlpacaRequest,
  onEvaluationStateChange,
}: EvaluationPanelProps) {
  const [timeframe, setTimeframe] = useState<EvaluationTimeframe>('15m');
  const [showHowCalculated, setShowHowCalculated] = useState(false);
  const [showEventDetails, setShowEventDetails] = useState(false);

  const {
    report,
    isLoading,
    progress,
    error,
    sourceLabel,
    fetchedAt,
    windowConfig,
    runEvaluation,
  } = useEvaluationHistory({
    source,
    symbol,
    timeframe,
    basis,
    alpacaFeed,
    alpacaConfigured,
    onAfterAlpacaRequest,
  });

  useEffect(() => {
    if (error) {
      onEvaluationStateChange?.({
        completed: false,
        errorMessage: error.message,
        summaryDetail: null,
      });
    } else if (report && report.candleCount > 0) {
      onEvaluationStateChange?.({
        completed: true,
        errorMessage: null,
        summaryDetail: `Verified live on ${symbol ?? 'instrument'} ${windowConfig.apiTimeframe} (${report.candleCount} bars, ${report.events.length} events)`,
      });
    } else {
      onEvaluationStateChange?.({
        completed: false,
        errorMessage: null,
        summaryDetail: null,
      });
    }
  }, [report, error, symbol, windowConfig.apiTimeframe, onEvaluationStateChange]);

  const handleSelectTimeframe = (next: EvaluationTimeframe) => {
    setTimeframe(next);
    setShowEventDetails(false);
  };

  const handleRunClick = () => {
    setShowEventDetails(false);
    void runEvaluation();
  };

  const activeWindows =
    source === 'delta' ? DELTA_EVALUATION_WINDOWS : ALPACA_EVALUATION_WINDOWS;

  const canRun =
    Boolean(symbol) &&
    !isLoading &&
    (source === 'delta' || alpacaConfigured === true);

  const hasAnySampleWarning = Boolean(
    report &&
      (report.whole.allAlerts.insufficientSample ||
        report.firstHalf.allAlerts.insufficientSample ||
        report.secondHalf.allAlerts.insufficientSample ||
        report.whole.pauseOnly.insufficientSample),
  );

  const recentEventsPreview = report
    ? report.eventMatchesAllAlerts.slice(-12).reverse()
    : [];

  return (
    <section
      aria-label="Phase 5 Detector Evaluation"
      data-testid="evaluation-panel"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Fixed Required Descriptive Disclaimer Label */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 bg-[#0B1120]/70 px-5 py-2 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          <span>
            Descriptive historical audit of this symbol and period. Past behavior does not imply future results. Advisory only. Not financial advice. This app does not place orders.
          </span>
        </div>
      </div>

      {/* Header + Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3.5">
        <div className="space-y-0.5">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Detector Historical Evaluation (Phase 5)
          </h2>
          <p className="text-[11px] text-slate-400">
            Causal historical audit: whether guardrail alerts preceded large moves in this sample
            {symbol ? (
              <>
                {' '}
                · <span className="font-mono text-slate-300">{symbol}</span>
              </>
            ) : null}{' '}
            · Source: <span className="font-mono text-slate-300">{source === 'delta' ? 'Delta' : 'Alpaca'}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Evaluation timeframe"
            className="inline-flex rounded-md border border-slate-800 bg-[#0B1120] p-0.5"
          >
            {(['15m', '1h'] as const).map((tf) => {
              const selected = timeframe === tf;
              return (
                <button
                  key={tf}
                  type="button"
                  onClick={() => handleSelectTimeframe(tf)}
                  disabled={isLoading}
                  className={`rounded px-2.5 py-1 font-mono text-xs transition-colors cursor-pointer disabled:opacity-50 ${
                    selected
                      ? 'bg-slate-800 font-semibold text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {activeWindows[tf].apiTimeframe}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            aria-expanded={showHowCalculated}
            onClick={() => setShowHowCalculated((prev) => !prev)}
            className="flex items-center gap-1.5 rounded-md border border-slate-800 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-slate-100 cursor-pointer transition-colors"
          >
            {showHowCalculated ? (
              <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            )}
            <span>How this is calculated</span>
          </button>

          <button
            type="button"
            onClick={handleRunClick}
            disabled={!canRun}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-950/40 px-3.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/40 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{isLoading ? 'Evaluating…' : 'Run evaluation'}</span>
          </button>
        </div>
      </div>

      {/* Metadata Strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-slate-800/70 bg-[#0B1120]/40 px-5 py-2 font-mono text-[11px] text-slate-300 tabular-nums">
        <span>
          Symbol: <strong className="text-slate-100">{symbol ?? '—'}</strong>
        </span>
        <span>
          Source:{' '}
          <strong className="text-slate-100">{source === 'delta' ? 'Delta' : 'Alpaca'}</strong>
        </span>
        <span>
          Timeframe: <strong className="text-slate-100">{windowConfig.label}</strong>
        </span>
        <span>
          Bars loaded:{' '}
          <strong className="text-slate-100">
            {isLoading && progress
              ? `${progress.barsLoaded} (${progress.completedWindows}/${progress.totalWindows} windows)`
              : report
                ? `${report.candleCount} / ${EVALUATION_MAX_TOTAL_BARS} max`
                : '0 (manual run not started)'}
          </strong>
        </span>
        <span>
          Date range:{' '}
          <strong className="text-slate-100">
            {report
              ? `${formatUtcMinute(report.startTime)} → ${formatUtcMinute(report.endTime)}`
              : '—'}
          </strong>
        </span>
      </div>

      {/* Body Area */}
      <div className="px-5 py-4 space-y-4">
        {source === 'alpaca' && alpacaConfigured !== true && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-md border border-slate-700/80 bg-[#0B1120]/80 px-4 py-3 text-xs text-slate-300"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            <span>
              Alpaca evaluation requires server credentials (ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY). Switch to Delta or configure Alpaca to run historical evaluation.
            </span>
          </div>
        )}

        {isLoading && (
          <div
            role="status"
            aria-label="Loading evaluation history"
            className="rounded-md border border-slate-800 bg-[#0B1120]/70 px-4 py-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2 text-xs text-slate-200">
              <span className="flex items-center gap-2 font-medium">
                <Activity className="h-3.5 w-3.5 animate-pulse text-emerald-400" aria-hidden="true" />
                <span>
                  Fetching paginated historical candles ({windowConfig.label})…
                </span>
              </span>
              <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                Window {progress?.completedWindows ?? 0}/{progress?.totalWindows ?? 0} ·{' '}
                {progress?.barsLoaded ?? 0} bars loaded
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
              <div
                className="h-full bg-emerald-500/80 transition-all duration-200"
                style={{
                  width:
                    progress && progress.totalWindows > 0
                      ? `${Math.round((progress.completedWindows / progress.totalWindows) * 100)}%`
                      : '10%',
                }}
              />
            </div>
          </div>
        )}

        {!isLoading && error && (
          <div
            role="alert"
            className="rounded-md border border-rose-500/35 bg-rose-950/25 p-4 text-xs text-rose-200 space-y-1"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="space-y-1 min-w-0">
                <p className="font-medium text-rose-100">
                  Historical evaluation failed
                  {error.status !== null ? ` (HTTP ${error.status})` : ''}
                </p>
                <p className="break-words font-mono text-[11px] text-rose-200">
                  {error.code ? `[${error.code}] ` : ''}
                  {error.message}
                </p>
                <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                  Timestamp: {formatTimestamp(error.timestamp)}
                </p>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && !report && (
          <p className="text-xs text-slate-400">
            {symbol
              ? `Click "Run evaluation" to fetch up to ${EVALUATION_MAX_TOTAL_BARS} real historical ${windowConfig.apiTimeframe} candles for ${symbol} and measure causal alert lead time and false-alarm rates in this sample.`
              : 'Select an instrument to enable manual historical evaluation.'}
          </p>
        )}

        {!isLoading && !error && report && (
          <div className="space-y-4">
            {report.gapCount > 0 && (
              <div
                role="status"
                className="flex items-center gap-2 rounded-md border border-amber-500/35 bg-amber-950/20 px-4 py-2 text-xs text-amber-200"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                <span className="font-mono">
                  {report.gapCount} {report.gapCount === 1 ? 'gap' : 'gaps'} detected in loaded history (cross-gap log returns skipped in signal/CUSUM calculation).
                </span>
              </div>
            )}

            {hasAnySampleWarning && (
              <div
                role="status"
                data-testid="evaluation-sample-warning"
                className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-950/25 px-4 py-3 text-xs text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-medium text-amber-200">
                    Small-sample warning (minimum {DEFAULT_MIN_SAMPLE_EVENTS} events and{' '}
                    {DEFAULT_MIN_SAMPLE_EPISODES} alert episodes required per bucket)
                  </p>
                  <p className="text-[11px] text-amber-200/90">
                    Any split or alert tier below those counts returns &ldquo;Insufficient sample&rdquo; instead of displaying unreliable percentages.
                    {report.whole.allAlerts.insufficientSampleReason
                      ? ` Whole-sample status: ${report.whole.allAlerts.insufficientSampleReason}.`
                      : ''}
                  </p>
                </div>
              </div>
            )}

            <EvaluationMetricsTable
              title="All Guardrail Alerts (PAUSE or REDUCE_SIZE)"
              subtitle="In this sample, measures whether any PAUSE or REDUCE_SIZE bar preceded a forward spike event within L bars, and whether alert episodes were followed by a spike within H bars."
              whole={report.whole.allAlerts}
              firstHalf={report.firstHalf.allAlerts}
              secondHalf={report.secondHalf.allAlerts}
              testIdPrefix="evaluation-table-all"
            />

            <EvaluationMetricsTable
              title="PAUSE-Only Alerts (Severe Guardrail Subset)"
              subtitle="Isolated measurement using only PAUSE bars (excluding REDUCE_SIZE) against the same spike events."
              whole={report.whole.pauseOnly}
              firstHalf={report.firstHalf.pauseOnly}
              secondHalf={report.secondHalf.pauseOnly}
              testIdPrefix="evaluation-table-pause"
            />

            {/* Expandable Individual Event & Lead-Time Breakdown */}
            <div className="rounded-md border border-slate-800/90 bg-[#0B1120]/60">
              <button
                type="button"
                aria-expanded={showEventDetails}
                onClick={() => setShowEventDetails((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs font-medium text-slate-300 hover:text-slate-100 cursor-pointer"
              >
                <span>
                  Recent Detected Spike Events ({report.events.length} total in sample — showing latest{' '}
                  {recentEventsPreview.length})
                </span>
                {showEventDetails ? (
                  <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                )}
              </button>

              {showEventDetails && (
                <div className="border-t border-slate-800/80 overflow-x-auto">
                  {recentEventsPreview.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-slate-400">
                      No spike events exceeded {DEFAULT_EVENT_SIGMA_K}σ over {DEFAULT_EVENT_HORIZON_BARS}-bar horizons in this sample.
                    </p>
                  ) : (
                    <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums">
                      <thead>
                        <tr className="border-b border-slate-800/80 text-slate-400">
                          <th className="px-4 py-2 font-medium">Event Start (UTC)</th>
                          <th className="px-4 py-2 font-medium">Bar</th>
                          <th className="px-4 py-2 font-medium">{report.options.horizonBars}-Bar Move</th>
                          <th className="px-4 py-2 font-medium">Earliest Alert in L={report.options.leadLookbackBars}</th>
                          <th className="px-4 py-2 font-medium">Lead Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-200">
                        {recentEventsPreview.map((item) => (
                          <tr key={item.event.startBar}>
                            <td className="px-4 py-2">{formatUtcMinute(item.event.startTime)}</td>
                            <td className="px-4 py-2 text-slate-400">#{item.event.startBar}</td>
                            <td
                              className={
                                item.event.forwardReturn >= 0 ? 'px-4 py-2 text-emerald-300' : 'px-4 py-2 text-rose-300'
                              }
                            >
                              {item.event.forwardReturn >= 0 ? '+' : ''}
                              {(item.event.forwardReturn * 100).toFixed(2)}% (thresh{' '}
                              {(item.event.thresholdReturn * 100).toFixed(2)}%)
                            </td>
                            <td className="px-4 py-2">
                              {item.hit && item.earliestAlertTime !== null
                                ? `${formatUtcMinute(item.earliestAlertTime)} (#${item.earliestAlertBar})`
                                : 'Missed (no alert in L)'}
                            </td>
                            <td className="px-4 py-2">
                              {item.leadTimeBars !== null && item.leadTimeMinutes !== null
                                ? `${item.leadTimeBars} bars (${item.leadTimeMinutes} min)`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Collapsible How This Is Calculated (derived strictly from exported constants) */}
      {showHowCalculated && (
        <div
          data-testid="evaluation-how-calculated"
          className="border-t border-slate-800/80 bg-[#0B1120]/80 px-5 py-4 text-xs text-slate-300 space-y-3"
        >
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded border border-slate-800 bg-[#111A2E]/70 p-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                Spike Event &amp; Lead-Time Constants
              </div>
              <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                <li>
                  Horizon H = {DEFAULT_EVENT_HORIZON_BARS} bars (non-overlapping spacing ≥ {DEFAULT_EVENT_HORIZON_BARS} bars)
                </li>
                <li>
                  Spike threshold K = {DEFAULT_EVENT_SIGMA_K} × causal trailing stdev of H-bar returns
                </li>
                <li>
                  Trailing spike vol window = {DEFAULT_SPIKE_VOL_LOOKBACK_BARS} bars (min {DEFAULT_SPIKE_MIN_RETURN_SAMPLES} samples, strictly bars ≤ i)
                </li>
                <li>
                  Lead-time lookback L = {DEFAULT_LEAD_LOOKBACK_BARS} bars ([e − {DEFAULT_LEAD_LOOKBACK_BARS}, e] inclusive)
                </li>
                <li>
                  Sample gate: ≥ {DEFAULT_MIN_SAMPLE_EVENTS} events and ≥ {DEFAULT_MIN_SAMPLE_EPISODES} alert episodes
                </li>
              </ul>
            </div>

            <div className="rounded border border-slate-800 bg-[#111A2E]/70 p-3 space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                History Windows &amp; Circular-Shift Baseline
              </div>
              <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                <li>Max evaluated bars cap = {EVALUATION_MAX_TOTAL_BARS}</li>
                <li>Delta 15m: {DELTA_EVALUATION_WINDOWS['15m'].label}</li>
                <li>Delta 1h: {DELTA_EVALUATION_WINDOWS['1h'].label}</li>
                <li>
                  Alpaca: {ALPACA_EVALUATION_WINDOWS['15m'].label} / {ALPACA_EVALUATION_WINDOWS['1h'].label}
                </li>
                <li>
                  Circular-shift offsets (% of series): {DEFAULT_CIRCULAR_SHIFT_PERCENTS.join('%, ')}%
                </li>
              </ul>
            </div>
          </div>

          <div className="rounded border border-slate-800 bg-[#111A2E]/70 p-3 space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Unchanged Causal Signal &amp; Guardrail Constants Used
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-slate-300">
              Signals: volWindow={DEFAULT_VOL_WINDOW}, volLookback={DEFAULT_VOL_LOOKBACK}, trendWindow=
              {DEFAULT_TREND_WINDOW}, cusumVolWindow={DEFAULT_CUSUM_VOL_WINDOW}, cusumK={DEFAULT_CUSUM_K}, cusumH=
              {DEFAULT_CUSUM_H}, cusumDecayBars={DEFAULT_CUSUM_DECAY_BARS}, weights=(vol=
              {DEFAULT_SCORE_WEIGHTS.volatility}, trend={DEFAULT_SCORE_WEIGHTS.trend}, cusum=
              {DEFAULT_SCORE_WEIGHTS.cusum}). Guardrails: PAUSE(score≥{DEFAULT_PAUSE_SCORE}, volZ≥+
              {DEFAULT_PAUSE_VOL_Z}σ, cpAge≤{DEFAULT_PAUSE_CHANGEPOINT_AGE_BARS}), REDUCE_SIZE(score≥
              {DEFAULT_REDUCE_SCORE}, volZ≥+{DEFAULT_REDUCE_VOL_Z}σ, cpAge≤
              {DEFAULT_REDUCE_CHANGEPOINT_AGE_BARS}).
            </p>
          </div>
        </div>
      )}

      {/* Provenance Footer */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 font-mono text-[11px] text-slate-400 tabular-nums">
        <span>
          Source: {sourceLabel ?? (source === 'delta' ? 'Delta Exchange India REST' : 'Alpaca Market Data')} ·
          Last run: {formatTimestamp(fetchedAt)} · Causal bar-by-bar evaluation (zero lookahead)
        </span>
      </div>
    </section>
  );
}
