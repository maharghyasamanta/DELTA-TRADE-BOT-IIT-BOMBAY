import { Activity, AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { AlpacaStatusResponse } from '../contracts/alpaca';
import { formatTimestamp } from '../utils/format';

interface AlpacaHealthBadgeProps {
  status: AlpacaStatusResponse | null;
  isChecking: boolean;
  fetchError: string | null;
  onRefresh: () => void;
}

export function AlpacaHealthBadge({
  status,
  isChecking,
  fetchError,
  onRefresh,
}: AlpacaHealthBadgeProps) {
  let label = 'Checking Alpaca';
  let toneClass = 'text-slate-400 border-slate-700/80 bg-slate-900/80';
  let StatusIcon = Activity;
  let tooltip = 'Source: Alpaca · Checking server status';

  if (fetchError) {
    label = `Alpaca Error · ${formatTimestamp(new Date().toISOString())}`;
    toneClass = 'text-rose-400 border-rose-500/30 bg-rose-950/30';
    StatusIcon = WifiOff;
    tooltip = `Source: Alpaca · ${fetchError} · Last updated: ${formatTimestamp(new Date().toISOString())}`;
  } else if (status) {
    const checkedLabel = formatTimestamp(status.checkedAt);
    if (!status.configured) {
      label = 'Alpaca Not Configured';
      toneClass = 'text-slate-400 border-slate-700/80 bg-slate-900/80';
      StatusIcon = WifiOff;
      tooltip = `Source: Alpaca · Not configured · Last updated: ${checkedLabel}`;
    } else if (status.lastError) {
      label = `Alpaca Error · ${checkedLabel}`;
      toneClass = 'text-rose-400 border-rose-500/30 bg-rose-950/30';
      StatusIcon = AlertTriangle;
      tooltip = `Source: Alpaca · ${status.lastError} (${checkedLabel}) · Last updated: ${checkedLabel}`;
    } else if (status.lastSuccessAt !== null) {
      const successLabel = formatTimestamp(status.lastSuccessAt);
      label = `Alpaca Connected · ${successLabel}`;
      toneClass = 'text-emerald-400 border-emerald-500/30 bg-emerald-950/30';
      StatusIcon = Activity;
      tooltip = `Source: Alpaca · Last success: ${successLabel} · Last updated: ${checkedLabel}`;
    } else {
      label = 'Alpaca Configured — no successful call yet';
      toneClass = 'text-slate-300 border-slate-700/80 bg-slate-900/80';
      StatusIcon = Activity;
      tooltip = `Source: Alpaca · Configured, awaiting first call · Last updated: ${checkedLabel}`;
    }
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={isChecking}
      title={tooltip}
      aria-label={`Alpaca status: ${label}. Click to re-check.`}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs font-medium tabular-nums whitespace-nowrap shrink-0 transition-colors duration-150 cursor-pointer hover:brightness-110 disabled:opacity-60 ${toneClass}`}
    >
      <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      <RefreshCw
        className={`h-3 w-3 shrink-0 opacity-75 ${isChecking ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
    </button>
  );
}
