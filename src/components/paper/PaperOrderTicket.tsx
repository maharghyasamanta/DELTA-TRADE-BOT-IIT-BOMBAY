import { useState } from 'react';
import { OctagonAlert, Play, Square } from 'lucide-react';
import type { PaperSessionState } from '../../contracts/paper';

interface PaperOrderTicketProps {
  session: PaperSessionState;
  busyAction: string | null;
  onSubmitOrder: (body: {
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    contracts: number;
    limitPriceTicks?: number | null;
    stopLossTicks?: number | null;
    takeProfitTicks?: number | null;
    reduceOnly?: boolean;
  }) => Promise<unknown>;
  onTriggerKillSwitch: () => Promise<void>;
  onToggleStrategy: (enabled: boolean) => Promise<void>;
  onUpdateTimeZone: (tz: string) => Promise<void>;
  onResetHalts: (opts: {
    resetDailyLossHalt?: boolean;
    resetDrawdownHalt?: boolean;
    resetKillSwitch?: boolean;
    resetStaleSession?: boolean;
  }) => Promise<void>;
}

const TIMEZONE_PRESETS = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Singapore'];

export function PaperOrderTicket({
  session,
  busyAction,
  onSubmitOrder,
  onTriggerKillSwitch,
  onToggleStrategy,
  onUpdateTimeZone,
  onResetHalts,
}: PaperOrderTicketProps) {
  const tickNum = Number(session.contract.tickSizeStr) || 0.5;
  const markPrice = session.account.lastMarkPriceTicks
    ? session.account.lastMarkPriceTicks * tickNum
    : null;

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [contractsStr, setContractsStr] = useState('1');
  const [limitPriceStr, setLimitPriceStr] = useState('');
  const [stopPriceStr, setStopPriceStr] = useState('');
  const [takeProfitStr, setTakeProfitStr] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tzInput, setTzInput] = useState(session.account.resetTimeZone);
  const [clientKeyCounter, setClientKeyCounter] = useState(1);

  const toTicks = (valStr: string): number | null => {
    const trimmed = valStr.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.max(1, Math.round(n / tickNum));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const contracts = Math.max(1, Math.floor(Number(contractsStr) || 1));
    const clientOrderId = `ui_${session.account.sessionId}_${Date.now()}_${clientKeyCounter}`;
    setClientKeyCounter((c) => c + 1);
    await onSubmitOrder({
      clientOrderId,
      side,
      type: orderType,
      contracts,
      limitPriceTicks: orderType === 'LIMIT' ? toTicks(limitPriceStr) : null,
      stopLossTicks: toTicks(stopPriceStr),
      takeProfitTicks: toTicks(takeProfitStr),
      reduceOnly,
    });
  };

  const isHalted =
    session.account.stale ||
    session.account.killSwitchActive ||
    session.account.dailyLossHalted ||
    session.account.drawdownHalted;

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Simulated Order Ticket & Bot Controls</h3>
          <p className="text-xs text-slate-400">
            Tick {session.contract.tickSizeStr} · Contract {session.contract.contractValueStr}{' '}
            {markPrice !== null ? `· Mark ~$${markPrice.toFixed(2)}` : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onTriggerKillSwitch()}
          disabled={Boolean(busyAction)}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/60 bg-rose-950/60 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-900/70 disabled:opacity-50 cursor-pointer"
        >
          <OctagonAlert className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
          Kill Switch: Flatten & Halt
        </button>
      </div>

      {isHalted && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
        >
          <div>
            <span className="font-semibold">Trading Halted: </span>
            {session.account.stale && (session.account.staleReason ?? 'Stale (>7d offline). ')}
            {session.account.killSwitchActive && 'Kill switch active. '}
            {session.account.dailyLossHalted && 'Daily loss limit reached. '}
            {session.account.drawdownHalted && 'Max drawdown limit reached. '}
          </div>
          <button
            type="button"
            onClick={() =>
              void onResetHalts({
                resetDailyLossHalt: session.account.dailyLossHalted,
                resetDrawdownHalt: session.account.drawdownHalted,
                resetKillSwitch: session.account.killSwitchActive,
                resetStaleSession: session.account.stale,
              })
            }
            disabled={Boolean(busyAction)}
            className="rounded border border-amber-400/50 bg-amber-900/50 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-900/80 cursor-pointer"
          >
            Reset Halts
          </button>
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex gap-2 sm:col-span-2">
          <button
            type="button"
            onClick={() => setSide('BUY')}
            className={`flex-1 rounded-md border py-2 text-xs font-semibold cursor-pointer ${
              side === 'BUY'
                ? 'border-emerald-500/60 bg-emerald-950/60 text-emerald-200'
                : 'border-slate-700/80 bg-[#0B1120] text-slate-400 hover:text-slate-200'
            }`}
          >
            Simulated BUY / LONG
          </button>
          <button
            type="button"
            onClick={() => setSide('SELL')}
            className={`flex-1 rounded-md border py-2 text-xs font-semibold cursor-pointer ${
              side === 'SELL'
                ? 'border-rose-500/60 bg-rose-950/60 text-rose-200'
                : 'border-slate-700/80 bg-[#0B1120] text-slate-400 hover:text-slate-200'
            }`}
          >
            Simulated SELL / SHORT
          </button>
        </div>

        <div>
          <label htmlFor="paper-order-type" className="block text-[11px] font-medium text-slate-400 mb-1">
            Order Type
          </label>
          <select
            id="paper-order-type"
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as 'MARKET' | 'LIMIT')}
            className="w-full rounded border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs text-slate-100"
          >
            <option value="MARKET">Market (bid/ask + slippage)</option>
            <option value="LIMIT">Limit (strict cross, maker fee)</option>
          </select>
        </div>

        <div>
          <label htmlFor="paper-contracts" className="block text-[11px] font-medium text-slate-400 mb-1">
            Contracts (integer)
          </label>
          <input
            id="paper-contracts"
            type="number"
            min={1}
            max={100000}
            step={1}
            value={contractsStr}
            onChange={(e) => setContractsStr(e.target.value)}
            className="w-full rounded border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
          />
        </div>

        {orderType === 'LIMIT' && (
          <div className="sm:col-span-2">
            <label htmlFor="paper-limit-price" className="block text-[11px] font-medium text-slate-400 mb-1">
              Limit Price (USD)
            </label>
            <input
              id="paper-limit-price"
              type="number"
              step={session.contract.tickSizeStr}
              placeholder={markPrice ? markPrice.toFixed(1) : '60000'}
              value={limitPriceStr}
              onChange={(e) => setLimitPriceStr(e.target.value)}
              className="w-full rounded border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
            />
          </div>
        )}

        <div>
          <label htmlFor="paper-stop-loss" className="block text-[11px] font-medium text-slate-400 mb-1">
            Stop Loss (USD, optional)
          </label>
          <input
            id="paper-stop-loss"
            type="number"
            step={session.contract.tickSizeStr}
            placeholder="Optional"
            value={stopPriceStr}
            onChange={(e) => setStopPriceStr(e.target.value)}
            className="w-full rounded border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
          />
        </div>

        <div>
          <label htmlFor="paper-take-profit" className="block text-[11px] font-medium text-slate-400 mb-1">
            Take Profit (USD, optional)
          </label>
          <input
            id="paper-take-profit"
            type="number"
            step={session.contract.tickSizeStr}
            placeholder="Optional"
            value={takeProfitStr}
            onChange={(e) => setTakeProfitStr(e.target.value)}
            className="w-full rounded border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2 cursor-pointer">
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(e) => setReduceOnly(e.target.checked)}
            className="rounded border-slate-700 bg-[#0B1120]"
          />
          Reduce-Only (close/reduce existing position only)
        </label>

        <button
          type="submit"
          disabled={Boolean(busyAction) || isHalted}
          className="sm:col-span-2 rounded-md border border-sky-500/50 bg-sky-600/20 px-4 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-600/30 disabled:opacity-50 cursor-pointer"
        >
          {busyAction ? busyAction : `Place Simulated ${side} ${orderType} Order`}
        </button>
      </form>

      {/* Baseline Bot Automation + Daily Reset TZ */}
      <div className="border-t border-slate-800/80 pt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-[#0B1120] px-3 py-2">
          <div>
            <div className="text-xs font-medium text-slate-200">Baseline Trend Bot</div>
            <div className="text-[11px] text-slate-400">
              {session.activeVersion.label}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onToggleStrategy(!session.account.strategyEnabled)}
            disabled={Boolean(busyAction) || session.account.stale || session.account.killSwitchActive}
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium cursor-pointer disabled:opacity-50 ${
              session.account.strategyEnabled
                ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'
                : 'border-slate-700 bg-slate-900 text-slate-300'
            }`}
          >
            {session.account.strategyEnabled ? (
              <>
                <Square className="h-3 w-3" aria-hidden="true" />
                Running
              </>
            ) : (
              <>
                <Play className="h-3 w-3" aria-hidden="true" />
                Start Bot
              </>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2 rounded border border-slate-800 bg-[#0B1120] px-3 py-2">
          <label htmlFor="paper-tz-select" className="text-[11px] text-slate-400 shrink-0">
            Daily Reset TZ
          </label>
          <select
            id="paper-tz-select"
            value={tzInput}
            onChange={(e) => {
              setTzInput(e.target.value);
              void onUpdateTimeZone(e.target.value);
            }}
            className="flex-1 rounded border border-slate-700/80 bg-[#111A2E] px-2 py-1 font-mono text-[11px] text-slate-100"
          >
            {TIMEZONE_PRESETS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
