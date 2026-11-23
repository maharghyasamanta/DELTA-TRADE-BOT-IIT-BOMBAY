import { useMemo, useState } from 'react';
import { AlertCircle, RefreshCw, Search } from 'lucide-react';
import type { DeltaProductSummary } from '../contracts/delta';
import { formatContractTypeLabel, formatTimestamp } from '../utils/format';

interface InstrumentPickerProps {
  products: DeltaProductSummary[];
  underlyings: string[];
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  isLoading: boolean;
  error: { message: string; timestamp: string } | null;
  source: string | null;
  fetchedAt: string | null;
  onRetry: () => void;
}

type TypeFilter = 'all' | 'perpetual_futures' | 'call_options' | 'put_options';

const TYPE_TABS: ReadonlyArray<{ id: TypeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'perpetual_futures', label: 'Perpetuals' },
  { id: 'call_options', label: 'Calls' },
  { id: 'put_options', label: 'Puts' },
];

const MAX_VISIBLE_ROWS = 200;

export function InstrumentPicker({
  products,
  underlyings,
  selectedSymbol,
  onSelectSymbol,
  isLoading,
  error,
  source,
  fetchedAt,
  onRetry,
}: InstrumentPickerProps) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [underlyingFilter, setUnderlyingFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (typeFilter !== 'all' && p.contractType !== typeFilter) return false;
      if (underlyingFilter !== 'ALL' && p.underlyingSymbol !== underlyingFilter) return false;
      if (q) {
        const symMatch = p.symbol.toLowerCase().includes(q);
        const descMatch = p.description.toLowerCase().includes(q);
        if (!symMatch && !descMatch) return false;
      }
      return true;
    });
  }, [products, typeFilter, underlyingFilter, searchQuery]);

  const visibleProducts = useMemo(
    () => filteredProducts.slice(0, MAX_VISIBLE_ROWS),
    [filteredProducts],
  );

  return (
    <aside
      aria-label="Instrument Picker"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E] lg:h-[calc(100vh-148px)] lg:min-h-[620px]"
    >
      <div className="border-b border-slate-800/80 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-slate-100">
            Instruments
          </h2>
          <button
            type="button"
            onClick={onRetry}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-slate-200 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Segmented Type Filter */}
        <div className="mt-3 grid grid-cols-4 gap-1 rounded-md bg-[#0B1120] p-1 border border-slate-800/70">
          {TYPE_TABS.map((tab) => {
            const active = typeFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setTypeFilter(tab.id)}
                className={`rounded px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                  active
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Search + Underlying Selector */}
        <div className="mt-2.5 flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search symbol..."
              aria-label="Search instrument symbol"
              className="w-full rounded-md border border-slate-800 bg-[#0B1120] py-1.5 pl-8 pr-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500/70 focus:outline-none"
            />
          </div>
          <select
            value={underlyingFilter}
            onChange={(e) => setUnderlyingFilter(e.target.value)}
            aria-label="Filter by underlying asset"
            className="rounded-md border border-slate-800 bg-[#0B1120] px-2.5 py-1.5 font-mono text-xs text-slate-200 focus:border-sky-500/70 focus:outline-none cursor-pointer"
          >
            <option value="ALL">All Assets</option>
            {underlyings.map((asset) => (
              <option key={asset} value={asset}>
                {asset}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums">
          <span>{filteredProducts.length.toLocaleString()} live contracts</span>
          {filteredProducts.length > MAX_VISIBLE_ROWS && (
            <span>Showing {MAX_VISIBLE_ROWS}</span>
          )}
        </div>
      </div>

      {/* Scrollable Contract List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
        {isLoading && products.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className="h-11 animate-pulse rounded border border-slate-800/60 bg-slate-900/50"
              />
            ))}
          </div>
        ) : error && products.length === 0 ? (
          <div className="p-4">
            <div className="rounded-md border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-300">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div className="space-y-1">
                  <p className="font-medium text-rose-200">Failed to load Delta products</p>
                  <p className="text-rose-300/90 break-words">{error.message}</p>
                  <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                    At {formatTimestamp(error.timestamp)}
                  </p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 rounded border border-rose-500/40 bg-rose-950/40 px-2.5 py-1 text-xs font-medium text-rose-200 hover:bg-rose-900/50 cursor-pointer"
                  >
                    Retry Request
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : visibleProducts.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            <p>No live contracts match your active filters.</p>
            <button
              type="button"
              onClick={() => {
                setTypeFilter('all');
                setUnderlyingFilter('ALL');
                setSearchQuery('');
              }}
              className="mt-2.5 rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
            >
              Clear Filters
            </button>
          </div>
        ) : (
          visibleProducts.map((product) => {
            const isSelected = product.symbol === selectedSymbol;
            const isOption =
              product.contractType === 'call_options' ||
              product.contractType === 'put_options';

            return (
              <button
                key={product.id}
                type="button"
                onClick={() => onSelectSymbol(product.symbol)}
                className={`w-full px-4 py-2.5 text-left transition-colors duration-100 cursor-pointer ${
                  isSelected
                    ? 'bg-sky-950/40 text-slate-100'
                    : 'hover:bg-slate-800/40 text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold tracking-tight text-slate-100 truncate">
                    {product.symbol}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400 shrink-0 tabular-nums">
                    {product.underlyingSymbol}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                  <span>{formatContractTypeLabel(product.contractType)}</span>
                  <span aria-hidden="true">·</span>
                  {isOption && product.strikePrice ? (
                    <span className="font-mono tabular-nums">
                      Strike {product.strikePrice}
                    </span>
                  ) : product.defaultLeverage ? (
                    <span className="font-mono tabular-nums">
                      {Number(product.defaultLeverage)}x max
                    </span>
                  ) : (
                    <span className="truncate">{product.description}</span>
                  )}
                  {product.tradingStatus !== 'operational' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-amber-400">{product.tradingStatus}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Source & Timestamp Provenance */}
      <div className="border-t border-slate-800/80 px-4 py-2.5 text-[11px] text-slate-400">
        <div className="truncate">{source || 'Source: Delta Exchange India /v2/products'}</div>
        <div className="mt-0.5 font-mono tabular-nums text-slate-500">
          Last updated: {formatTimestamp(fetchedAt)}
        </div>
      </div>
    </aside>
  );
}
