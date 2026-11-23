import { Activity, AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { AlpacaStatusResponse } from '../contracts/alpaca';
import { formatTimestamp } from '../utils/format';

export interface AlpacaLiveErrorState {
  status: number | null;
  code: string | null;
  message: string;
  timestamp: string;
}

interface AlpacaHealthBadgeProps {
  status: AlpacaStatusResponse | null;
  isChecking: boolean;
  fetchError: string | null;
  checkError?: AlpacaLiveErrorState | null;
  liveSuccessAt?: string | null;
  needsSymbolHint?: boolean;
  activeSymbol?: string | null;
  onRefresh: () => void;
}

export function AlpacaHealthBadge({
  status,
  isChecking,
  fetchError,
  checkError = null,
  liveSuccessAt = null,
  needsSymbolHint = false,
  activeSymbol = null,
  onRefresh,
}: AlpacaHealthBadgeProps) {
  let label = 'Checking Alpaca';
  let toneClass = 'text-slate-400 border-slate-700/80 bg-slate-900/80';
  let StatusIcon = Activity;
  let tooltip = 'Source: Alpaca · Checking server status';

  if (fetchError) {
    const nowLabel = formatTimestamp(new Date().toISOString());
    label = `Alpaca Error · ${nowLabel}`;
    toneClass = 'text-rose-400 border-rose-500/30 bg-rose-950/30';
    StatusIcon = WifiOff;
    tooltip = `Source: Alpaca · ${fetchError} · At ${nowLabel}`;
  } else if (checkError) {
    const errTimeLabel = formatTimestamp(checkError.timestamp);
    const statusTag = checkError.status !== null ? ` (${checkError.status})` : '';
    label = `Alpaca Error${statusTag} · ${errTimeLabel}`;
    toneClass = 'text-rose-400 border-rose-500/30 bg-rose-950/30';
    StatusIcon = AlertTriangle;
    tooltip = `Source: Alpaca${checkError.status !== null ? ` · HTTP ${checkError.status}` : ''} · ${checkError.message} · At ${errTimeLabel}`;
  } else if (needsSymbolHint && (!status || status.configured)) {
    label = 'Load a symbol to run a live check';
    toneClass = 'text-amber-300 border-amber-500/35 bg-amber-950/25';
    StatusIcon = AlertTriangle;
    tooltip =
      'Source: Alpaca · No symbol loaded in the Alpaca view. Load a symbol (for example AAPL) to run a live latest-trade check. No request was sent.';
  } else if (liveSuccessAt) {
    const successLabel = formatTimestamp(liveSuccessAt);
    label = `Alpaca Connected · ${successLabel}`;
    toneClass = 'text-emerald-400 border-emerald-500/30 bg-emerald-950/30';
    StatusIcon = Activity;
    tooltip = activeSymbol
      ? `Source: Alpaca · Latest trade check succeeded for ${activeSymbol} at ${successLabel} · Click to re-check`
      : `Source: Alpaca · Last success: ${successLabel}`;
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
      tooltip = activeSymbol
        ? `Source: Alpaca · Last success: ${successLabel} · Click to run a live latest-trade check for ${activeSymbol}`
        : `Source: Alpaca · Last success: ${successLabel} · Last updated: ${checkedLabel}`;
    } else {
      label = 'Alpaca Configured — no successful call yet';
      toneClass = 'text-slate-300 border-slate-700/80 bg-slate-900/80';
      StatusIcon = Activity;
      tooltip = activeSymbol
        ? `Source: Alpaca · Click to run a live latest-trade check for ${activeSymbol}`
        : `Source: Alpaca · Configured, awaiting first call · Last updated: ${checkedLabel}`;
    }
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={isChecking}
      title={tooltip}
      aria-label={`Alpaca status: ${label}. Click to run a live check.`}
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
