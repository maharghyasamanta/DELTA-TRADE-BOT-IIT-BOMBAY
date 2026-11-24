import { XCircle } from 'lucide-react';
import type { PaperSessionState } from '../../contracts/paper';
import { formatFixedUnits, stringToUnits } from '../../engine/decimal';
import { formatTimestamp, getTickDecimals } from '../../utils/format';

interface PaperPositionsOrdersPanelProps {
  session: PaperSessionState;
  busyAction: string | null;
  onCancelOrder: (clientOrderId: string) => Promise<void>;
}

export function PaperPositionsOrdersPanel({
  session,
  busyAction,
  onCancelOrder,
}: PaperPositionsOrdersPanelProps) {
  const tickNum = Number(session.contract.tickSizeStr) || 0.5;
  const priceDecimals = getTickDecimals(session.contract.tickSizeStr);
  const fmtTicks = (ticks: number | null) =>
    ticks !== null ? (ticks * tickNum).toFixed(priceDecimals) : '—';
  const fmtUsd = (units: string) => formatFixedUnits(stringToUnits(units), 2);

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">
          Open Positions ({session.openPositions.length}) & Working Orders ({session.openOrders.length})
        </h3>
        <span className="font-mono text-[11px] text-slate-400">
          Recent fills: {session.recentFills.length}
        </span>
      </div>

      {/* Open Positions */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
              <th className="py-2 pr-3">Side</th>
              <th className="py-2 pr-3">Qty</th>
              <th className="py-2 pr-3">Entry</th>
              <th className="py-2 pr-3">Mark</th>
              <th className="py-2 pr-3">Est. Liq</th>
              <th className="py-2 pr-3">SL / TP</th>
              <th className="py-2 pr-3">Margin (Alloc / MM)</th>
              <th className="py-2 text-right">Unrealized PnL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
            {session.openPositions.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-4 text-center font-sans text-slate-400">
                  No open simulated positions.
                </td>
              </tr>
            ) : (
              session.openPositions.map((pos) => {
                const upnl = stringToUnits(pos.unrealizedPnlUnits);
                return (
                  <tr key={pos.positionId} className="h-10 text-slate-200">
                    <td className="pr-3">
                      <span
                        className={`font-semibold ${
                          pos.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {pos.side}
                      </span>
                    </td>
                    <td className="pr-3">{pos.contracts}</td>
                    <td className="pr-3">${fmtTicks(pos.entryPriceTicks)}</td>
                    <td className="pr-3">${fmtTicks(pos.markPriceTicks)}</td>
                    <td className="pr-3 text-amber-300">${fmtTicks(pos.liquidationPriceTicks)}</td>
                    <td className="pr-3 text-slate-400">
                      {fmtTicks(pos.stopLossTicks)} / {fmtTicks(pos.takeProfitTicks)}
                    </td>
                    <td className="pr-3 text-slate-300">
                      ${fmtUsd(pos.allocatedMarginUnits)} / ${fmtUsd(pos.maintenanceMarginUnits)}
                    </td>
                    <td
                      className={`text-right font-semibold ${
                        upnl >= 0n ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {upnl >= 0n ? '+' : ''}${fmtUsd(pos.unrealizedPnlUnits)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Open Limit Orders */}
      {session.openOrders.length > 0 && (
        <div className="border-t border-slate-800/80 pt-3 overflow-x-auto">
          <div className="mb-2 text-xs font-medium text-slate-300">Working Limit Orders</div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-1.5 pr-3">Side</th>
                <th className="py-1.5 pr-3">Qty</th>
                <th className="py-1.5 pr-3">Limit Price</th>
                <th className="py-1.5 pr-3">SL / TP</th>
                <th className="py-1.5 pr-3">Guardrail</th>
                <th className="py-1.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {session.openOrders.map((ord) => (
                <tr key={ord.clientOrderId} className="h-9 text-slate-200">
                  <td className={`pr-3 font-semibold ${ord.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {ord.side}
                  </td>
                  <td className="pr-3">{ord.contracts}</td>
                  <td className="pr-3">${fmtTicks(ord.limitPriceTicks)}</td>
                  <td className="pr-3 text-slate-400">
                    {fmtTicks(ord.stopLossTicks)} / {fmtTicks(ord.takeProfitTicks)}
                  </td>
                  <td className="pr-3 font-sans text-slate-300">{ord.guardrail.decision}</td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={() => void onCancelOrder(ord.clientOrderId)}
                      disabled={Boolean(busyAction)}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 font-sans text-[11px] text-slate-300 hover:border-rose-500/50 hover:text-rose-200 cursor-pointer"
                    >
                      <XCircle className="h-3 w-3" aria-hidden="true" />
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Fills */}
      {session.recentFills.length > 0 && (
        <div className="border-t border-slate-800/80 pt-3 overflow-x-auto">
          <div className="mb-2 text-xs font-medium text-slate-300">Latest Simulated Fills</div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400">
                <th className="py-1.5 pr-3">Time</th>
                <th className="py-1.5 pr-3">Side</th>
                <th className="py-1.5 pr-3">Qty</th>
                <th className="py-1.5 pr-3">Fill / Mark</th>
                <th className="py-1.5 pr-3">Role / Slip</th>
                <th className="py-1.5 text-right">Fee (USDT)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono tabular-nums">
              {session.recentFills.slice(0, 8).map((f) => (
                <tr key={f.fillId} className="h-9 text-slate-300">
                  <td className="pr-3 text-slate-400">
                    {formatTimestamp(new Date(f.executedAtSec * 1000).toISOString())}
                    {f.replayed && (
                      <span className="ml-1.5 rounded border border-amber-500/40 bg-amber-950/50 px-1 py-0.5 text-[10px] text-amber-300">
                        replayed
                      </span>
                    )}
                  </td>
                  <td className={f.side === 'BUY' ? 'text-emerald-400 pr-3' : 'text-rose-400 pr-3'}>
                    {f.side}
                  </td>
                  <td className="pr-3">{f.contracts}</td>
                  <td className="pr-3">
                    ${fmtTicks(f.priceTicks)} / ${fmtTicks(f.markPriceTicks)}
                  </td>
                  <td className="pr-3">
                    {f.liquidityRole} · {f.slippageTicks}t
                  </td>
                  <td className="text-right text-slate-200">
                    ${formatFixedUnits(stringToUnits(f.feeUnits), 4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
