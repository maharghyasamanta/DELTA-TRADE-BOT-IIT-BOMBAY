import type { ReactNode } from 'react';
import { Activity, AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import type { AlpacaStatusResponse } from '../contracts/alpaca';
import type { DeltaWsConnectionState, HealthStatusResponse } from '../contracts/delta';
import { formatTimestamp } from '../utils/format';
import {
  AlpacaHealthBadge,
  type AlpacaLiveErrorState,
} from './AlpacaHealthBadge';

interface TopBarProps {
  health: HealthStatusResponse | null;
  wsStateOverride: DeltaWsConnectionState | null;
  isCheckingHealth: boolean;
  onRefreshHealth: () => void;
  alpacaStatus: AlpacaStatusResponse | null;
  isCheckingAlpaca: boolean;
  alpacaStatusError: string | null;
  alpacaLiveError?: AlpacaLiveErrorState | null;
  alpacaLiveSuccessAt?: string | null;
  alpacaNeedsSymbolHint?: boolean;
  activeAlpacaSymbol?: string | null;
  onRefreshAlpacaStatus: () => void;
  activeSection: 'monitor' | 'specs' | 'roadmap';
  onNavigate: (section: 'monitor' | 'specs' | 'roadmap') => void;
  authSlot?: ReactNode;
}

export function TopBar({
  health,
  wsStateOverride,
  isCheckingHealth,
  onRefreshHealth,
  alpacaStatus,
  isCheckingAlpaca,
  alpacaStatusError,
  alpacaLiveError = null,
  alpacaLiveSuccessAt = null,
  alpacaNeedsSymbolHint = false,
  activeAlpacaSymbol = null,
  onRefreshAlpacaStatus,
  activeSection,
  onNavigate,
  authSlot,
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
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-4 py-3 sm:px-6">
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
        <nav
          aria-label="Primary sections"
          className="order-3 flex w-full items-center gap-4 border-t border-slate-800/70 pt-2 text-xs font-medium md:order-none md:w-auto md:gap-5 md:border-t-0 md:pt-0 md:text-sm"
        >
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

        {/* Zone 3: Connection Health Badges */}
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <AlpacaHealthBadge
            status={alpacaStatus}
            isChecking={isCheckingAlpaca}
            fetchError={alpacaStatusError}
            checkError={alpacaLiveError}
            liveSuccessAt={alpacaLiveSuccessAt}
            needsSymbolHint={alpacaNeedsSymbolHint}
            activeSymbol={activeAlpacaSymbol}
            onRefresh={onRefreshAlpacaStatus}
          />
          <button
            type="button"
            onClick={onRefreshHealth}
            disabled={isCheckingHealth}
            title={
              health?.lastError
                ? `Last error: ${health.lastError}`
                : `Last checked: ${formatTimestamp(health?.checkedAt)}`
            }
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs font-medium tabular-nums whitespace-nowrap shrink-0 transition-colors duration-150 cursor-pointer hover:brightness-110 disabled:opacity-60 ${statusToneClass}`}
          >
            <StatusIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{statusLabel}</span>
            <RefreshCw
              className={`h-3 w-3 shrink-0 opacity-75 ${isCheckingHealth ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </button>
          {authSlot}
        </div>
      </div>
    </header>
  );
}
