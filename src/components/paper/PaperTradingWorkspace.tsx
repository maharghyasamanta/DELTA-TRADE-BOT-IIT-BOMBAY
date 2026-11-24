import { useMemo, useState } from 'react';
import { AlertCircle, LogIn, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import type { DeltaProductSummary } from '../../contracts/delta';
import { formatFixedUnits, stringToUnits } from '../../engine/decimal';
import { usePaperTrading } from '../../hooks/usePaperTrading';
import type { User } from 'firebase/auth';
import { PaperAnalyticsAndDrift } from './PaperAnalyticsAndDrift';
import { PaperEquityChart } from './PaperEquityChart';
import { PaperJournalAndReview } from './PaperJournalAndReview';
import { PaperOrderTicket } from './PaperOrderTicket';
import { PaperPositionsOrdersPanel } from './PaperPositionsOrdersPanel';
import { PaperWalkForwardPanel } from './PaperWalkForwardPanel';

interface PaperTradingWorkspaceProps {
  user: User | null;
  authReady: boolean;
  isFirebaseConfigured: boolean;
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  onSignIn: () => void;
  products: DeltaProductSummary[];
  defaultSymbol: string | null;
}

export function PaperTradingWorkspace({
  user,
  authReady,
  isFirebaseConfigured,
  getIdToken,
  onSignIn,
  products,
  defaultSymbol,
}: PaperTradingWorkspaceProps) {
  const perpProducts = useMemo(
    () => products.filter((p) => p.contractType === 'perpetual_futures'),
    [products],
  );

  const [newSymbol, setNewSymbol] = useState<string>(defaultSymbol ?? 'BTCUSD');
  const [newResolution, setNewResolution] = useState<'15m' | '1h'>('15m');
  const [newBalance, setNewBalance] = useState('10000');
  const [newMaxLev, setNewMaxLev] = useState('5');
  const [newTimeZone, setNewTimeZone] = useState('UTC');

  const paper = usePaperTrading({ user, getIdToken, active: true });

  const resolvedCreateSymbol =
    perpProducts.some((p) => p.symbol === newSymbol)
      ? newSymbol
      : perpProducts[0]?.symbol ?? 'BTCUSD';

  const active = paper.activeSession;
  const fmtUsd = (units: string) => formatFixedUnits(stringToUnits(units), 2);

  return (
    <div className="space-y-5">
      {/* Persistent mandatory simulated-funds banner */}
      <div
        role="banner"
        data-testid="paper-simulated-banner"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/45 bg-amber-950/35 px-4 py-2.5 text-xs text-amber-100"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-2 font-semibold tracking-wide whitespace-nowrap">
            <ShieldAlert className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>PAPER — SIMULATED FUNDS</span>
          </span>
          <span className="font-normal text-amber-200/90">
            · All orders, fills, margin & liquidations are simulated inside our server using live Delta Exchange India quotes. Zero real-money keys or exchange order paths.
          </span>
        </div>
        {active && (
          <span className="font-mono text-[11px] text-amber-200 tabular-nums">
            Day Key ({active.account.resetTimeZone}): {active.account.currentDayKey}
          </span>
        )}
      </div>

      {!authReady ? (
        <div className="rounded-lg border border-slate-800 bg-[#111A2E] p-8 text-center text-sm text-slate-300">
          Checking authentication state...
        </div>
      ) : !user ? (
        <div
          data-testid="paper-auth-gate"
          className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-8 text-center space-y-3"
        >
          <h2 className="text-lg font-semibold text-slate-100">
            Sign in required for Paper Trading
          </h2>
          <p className="mx-auto max-w-xl text-xs text-slate-400 leading-relaxed">
            Paper sessions require a verified Google account so your simulated accounts, orders,
            trade journal, and held-out audit log persist securely under your private Firestore
            ledger (max 5 sessions per user).
          </p>
          {isFirebaseConfigured ? (
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-2 rounded-md border border-sky-500/50 bg-sky-600/20 px-4 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-600/30 cursor-pointer"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Sign in with Google
            </button>
          ) : (
            <p className="text-xs text-rose-300">Firebase Auth is not configured in this environment.</p>
          )}
        </div>
      ) : (
        <>
          {paper.error && (
            <div
              role="alert"
              className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/30 px-4 py-3 text-xs text-rose-200"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" aria-hidden="true" />
                <span>{paper.error}</span>
              </div>
              <button
                type="button"
                onClick={paper.clearError}
                aria-label="Dismiss paper trading error"
                className="rounded p-1 hover:bg-rose-900/40 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {paper.restoreNotice && (
            <div
              role="status"
              className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/35 bg-emerald-950/25 px-4 py-2.5 text-xs text-emerald-200"
            >
              <span>{paper.restoreNotice}</span>
              <button
                type="button"
                onClick={paper.clearRestoreNotice}
                aria-label="Dismiss restore notice"
                className="rounded p-1 hover:bg-emerald-900/40 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {/* Session selector & new session bar */}
          <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Saved Sessions ({paper.sessions.length}/5):
                </span>
                {paper.sessions.map((s) => {
                  const isSel = active?.account.sessionId === s.account.sessionId;
                  return (
                    <div key={s.account.sessionId} className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => paper.setActiveSessionId(s.account.sessionId)}
                        className={`rounded-md border px-2.5 py-1 font-mono text-xs cursor-pointer ${
                          isSel
                            ? 'border-sky-500/60 bg-sky-950/50 text-sky-200'
                            : 'border-slate-700 bg-[#0B1120] text-slate-300 hover:text-slate-100'
                        }`}
                      >
                        {s.account.symbol} · {s.account.resolution} (${fmtUsd(s.account.equityUnits)})
                      </button>
                      <button
                        type="button"
                        onClick={() => void paper.deleteSession(s.account.sessionId)}
                        aria-label={`Delete session ${s.account.sessionId}`}
                        className="rounded p-1 text-slate-400 hover:text-rose-300 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void paper.createSession({
                  symbol: resolvedCreateSymbol,
                  resolution: newResolution,
                  startingBalanceUsdt: newBalance,
                  resetTimeZone: newTimeZone,
                  riskLimits: { maxLeverage: Math.max(1, Math.floor(Number(newMaxLev) || 5)) },
                });
              }}
              className="flex flex-wrap items-end gap-2.5 border-t border-slate-800/80 pt-3"
            >
              <div>
                <label htmlFor="new-session-symbol" className="block text-[11px] text-slate-400 mb-1">
                  Delta Perpetual
                </label>
                <select
                  id="new-session-symbol"
                  value={resolvedCreateSymbol}
                  onChange={(e) => setNewSymbol(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                >
                  {perpProducts.length > 0 ? (
                    perpProducts.map((p) => (
                      <option key={p.symbol} value={p.symbol}>
                        {p.symbol}
                      </option>
                    ))
                  ) : (
                    <option value="BTCUSD">BTCUSD</option>
                  )}
                </select>
              </div>

              <div>
                <label htmlFor="new-session-res" className="block text-[11px] text-slate-400 mb-1">
                  Resolution
                </label>
                <select
                  id="new-session-res"
                  value={newResolution}
                  onChange={(e) => setNewResolution(e.target.value as '15m' | '1h')}
                  className="rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                >
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                </select>
              </div>

              <div>
                <label htmlFor="new-session-bal" className="block text-[11px] text-slate-400 mb-1">
                  Starting USDT
                </label>
                <input
                  id="new-session-bal"
                  type="text"
                  value={newBalance}
                  onChange={(e) => setNewBalance(e.target.value)}
                  className="w-24 rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="new-session-lev" className="block text-[11px] text-slate-400 mb-1">
                  Max Lev
                </label>
                <input
                  id="new-session-lev"
                  type="number"
                  min={1}
                  max={25}
                  value={newMaxLev}
                  onChange={(e) => setNewMaxLev(e.target.value)}
                  className="w-16 rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100 tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="new-session-tz" className="block text-[11px] text-slate-400 mb-1">
                  Reset TZ
                </label>
                <select
                  id="new-session-tz"
                  value={newTimeZone}
                  onChange={(e) => setNewTimeZone(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                >
                  <option value="UTC">UTC</option>
                  <option value="Asia/Kolkata">Asia/Kolkata</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="Europe/London">Europe/London</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={Boolean(paper.busyAction) || paper.sessions.length >= 5}
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/50 bg-sky-600/20 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-600/30 disabled:opacity-50 cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New Paper Session
              </button>
            </form>
          </section>

          {paper.loading && !active ? (
            <div className="rounded-lg border border-slate-800 bg-[#111A2E] p-8 text-center text-xs text-slate-300">
              Restoring paper sessions & checking missed history...
            </div>
          ) : !active ? (
            <div className="rounded-lg border border-slate-800 bg-[#111A2E] p-8 text-center text-xs text-slate-400">
              No saved paper session yet. Create one above to begin simulated trading on live Delta Exchange India prices.
            </div>
          ) : (
            <>
              {/* Account KPI Strip */}
              <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 font-mono tabular-nums">
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Virtual Equity (Mark)</div>
                  <div className="mt-1 text-base font-semibold text-slate-100">
                    ${fmtUsd(active.account.equityUnits)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Free Balance</div>
                  <div className="mt-1 text-base font-semibold text-slate-100">
                    ${fmtUsd(active.account.balanceUnits)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Margin Used</div>
                  <div className="mt-1 text-base font-semibold text-slate-100">
                    ${fmtUsd(active.account.marginUsedUnits)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Realized PnL</div>
                  <div
                    className={`mt-1 text-base font-semibold ${
                      stringToUnits(active.account.realizedPnlUnits) >= 0n
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    ${fmtUsd(active.account.realizedPnlUnits)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Unrealized PnL</div>
                  <div
                    className={`mt-1 text-base font-semibold ${
                      stringToUnits(active.account.unrealizedPnlUnits) >= 0n
                        ? 'text-emerald-400'
                        : 'text-rose-400'
                    }`}
                  >
                    ${fmtUsd(active.account.unrealizedPnlUnits)}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-3">
                  <div className="font-sans text-[11px] text-slate-400">Max Leverage Cap</div>
                  <div className="mt-1 text-base font-semibold text-slate-100">
                    {active.account.riskLimits.maxLeverage}x{' '}
                    <span className="text-[11px] text-slate-400">
                      (prod {active.contract.defaultLeverage}x)
                    </span>
                  </div>
                </div>
              </section>

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)] items-start">
                <PaperEquityChart
                  equityCurve={active.equityCurve}
                  startingBalance={Number(active.account.startingBalanceUnits) / 1e8}
                />
                <PaperOrderTicket
                  session={active}
                  busyAction={paper.busyAction}
                  onSubmitOrder={paper.submitOrder}
                  onTriggerKillSwitch={paper.triggerKillSwitch}
                  onToggleStrategy={(enabled) => paper.updateSettings({ strategyEnabled: enabled })}
                  onUpdateTimeZone={(tz) => paper.updateSettings({ resetTimeZone: tz })}
                  onResetHalts={(opts) => paper.updateSettings(opts)}
                />
              </div>

              <PaperPositionsOrdersPanel
                session={active}
                busyAction={paper.busyAction}
                onCancelOrder={paper.cancelOrder}
              />

              <PaperJournalAndReview
                session={active}
                tradeReviews={paper.tradeReviews}
                reviewingTradeId={paper.reviewingTradeId}
                onExplainTrade={paper.explainTrade}
              />

              <PaperAnalyticsAndDrift
                analytics={paper.analytics}
                drift={paper.drift}
                onRefresh={() => paper.refreshAnalytics(active.account.sessionId)}
              />

              <PaperWalkForwardPanel
                session={active}
                busyAction={paper.busyAction}
                report={paper.walkForwardReport}
                heldOutResult={paper.heldOutResult}
                onRunWalkForward={paper.runWalkForward}
                onEvaluateHeldOut={paper.evaluateHeldOut}
                onActivateVersion={(v) => paper.updateSettings({ activeVersion: v })}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
