import { Activity, AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { DeltaWsConnectionState, HealthStatusResponse } from '../contracts/delta';
import { formatTimestamp } from '../utils/format';

interface TopBarProps {
  health: HealthStatusResponse | null;
  wsStateOverride: DeltaWsConnectionState | null;
  isCheckingHealth: boolean;
  onRefreshHealth: () => void;
  activeSection: 'monitor' | 'specs' | 'roadmap';
  onNavigate: (section: 'monitor' | 'specs' | 'roadmap') => void;
}

export function TopBar({
  health,
  wsStateOverride,
  isCheckingHealth,
  onRefreshHealth,
  activeSection,
  onNavigate,
}: TopBarProps) {
  const wsState = wsStateOverride ?? health?.deltaWsState ?? 'disconnected';
  const restOk = health?.deltaRestOk ?? false;

  let statusLabel = 'Checking API';
  let statusToneClass = 'text-slate-300 border-slate-700/80 bg-slate-900/80';
  let StatusIcon = Activity;

  if (health) {
    if (restOk && wsState === 'connected') {
      statusLabel = `API Connected${health.deltaRestLatencyMs !== null ? ` · ${health.deltaRestLatencyMs}ms` : ''}`;
      statusToneClass = 'text-emerald-400 border-emerald-500/30 bg-emerald-950/30';
      StatusIcon = Activity;
    } else if (restOk && (wsState === 'connecting' || wsState === 'reconnecting')) {
      statusLabel = `REST OK · WS ${wsState}`;
      statusToneClass = 'text-amber-400 border-amber-500/30 bg-amber-950/30';
      StatusIcon = AlertTriangle;
    } else if (restOk) {
      statusLabel = `REST OK · WS ${wsState}`;
      statusToneClass = 'text-amber-400 border-amber-500/30 bg-amber-950/30';
      StatusIcon = AlertTriangle;
    } else {
      statusLabel = 'API Disconnected';
      statusToneClass = 'text-rose-400 border-rose-500/30 bg-rose-950/30';
      StatusIcon = WifiOff;
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#0B1120]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-8 px-6 py-3.5">
        {/* Zone 1: Single-element Brand Wordmark */}
        <a
          href="#monitor"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('monitor');
          }}
          className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Regime Sentinel
        </a>

        {/* Zone 2: Clean single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          <button
            type="button"
            onClick={() => onNavigate('monitor')}
            className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors duration-150 cursor-pointer ${
              activeSection === 'monitor'
                ? 'text-slate-100 border-b border-sky-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Live Monitor
          </button>
          <button
            type="button"
            onClick={() => onNavigate('specs')}
            className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors duration-150 cursor-pointer ${
              activeSection === 'specs'
                ? 'text-slate-100 border-b border-sky-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Contract Specs
          </button>
          <button
            type="button"
            onClick={() => onNavigate('roadmap')}
            className={`whitespace-nowrap shrink-0 pb-0.5 transition-colors duration-150 cursor-pointer ${
              activeSection === 'roadmap'
                ? 'text-slate-100 border-b border-sky-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Phase Roadmap
          </button>
        </nav>

        {/* Zone 3: Single Primary Action / Connection Health */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onRefreshHealth}
            disabled={isCheckingHealth}
            title={
              health?.lastError
                ? `Last error: ${health.lastError}`
                : `Last checked: ${formatTimestamp(health?.checkedAt)}`
            }
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs font-medium tabular-nums whitespace-nowrap shrink-0 transition-colors duration-150 cursor-pointer hover:brightness-110 disabled:opacity-60 ${statusToneClass}`}
          >
            <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{statusLabel}</span>
            <RefreshCw
              className={`h-3 w-3 shrink-0 opacity-75 ${isCheckingHealth ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </header>
  );
}
