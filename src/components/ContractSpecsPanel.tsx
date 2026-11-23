import type { DeltaProductSummary } from '../contracts/delta';
import {
  formatContractTypeLabel,
  formatDateTimeUtc,
  formatTimestamp,
} from '../utils/format';

interface ContractSpecsPanelProps {
  product: DeltaProductSummary | null;
  source: string | null;
  fetchedAt: string | null;
}

export function ContractSpecsPanel({
  product,
  source,
  fetchedAt,
}: ContractSpecsPanelProps) {
  return (
    <section
      id="specs"
      aria-label="Contract Specifications"
      className="rounded-lg border border-slate-800/90 bg-[#111A2E] px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 pb-3">
        <h2 className="font-display text-sm font-semibold text-slate-100">
          Contract Specifications
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <span>{source || 'Delta Exchange India REST /v2/products'}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            Last updated: {formatTimestamp(fetchedAt)}
          </span>
        </div>
      </div>

      {!product ? (
        <p className="mt-3 text-xs text-slate-400">
          Select an instrument to inspect its exchange contract specifications.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <SpecField label="Product ID" value={String(product.id)} mono />
          <SpecField
            label="Contract Type"
            value={formatContractTypeLabel(product.contractType)}
          />
          <SpecField
            label="Underlying / Settle"
            value={`${product.underlyingSymbol || '—'} / ${product.settlingSymbol || '—'}`}
            mono
          />
          <SpecField label="Tick Size" value={product.tickSize || '—'} mono />
          <SpecField label="Contract Value" value={product.contractValue || '—'} mono />
          <SpecField label="Trading Status" value={product.tradingStatus || '—'} />
          <SpecField
            label="Strike Price"
            value={product.strikePrice ?? '—'}
            mono
          />
          <SpecField
            label="Settlement Time"
            value={formatDateTimeUtc(product.settlementTime)}
            mono
          />
          <SpecField
            label="Default Leverage"
            value={
              product.defaultLeverage
                ? `${Number(product.defaultLeverage)}x`
                : '—'
            }
            mono
          />
          <SpecField
            label="Maker Fee"
            value={
              product.makerCommissionRate
                ? `${(Number(product.makerCommissionRate) * 100).toFixed(3)}%`
                : '—'
            }
            mono
          />
          <SpecField
            label="Taker Fee"
            value={
              product.takerCommissionRate
                ? `${(Number(product.takerCommissionRate) * 100).toFixed(3)}%`
                : '—'
            }
            mono
          />
          <SpecField label="Description" value={product.description || '—'} />
        </div>
      )}
    </section>
  );
}

function SpecField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400 truncate">{label}</div>
      <div
        className={`mt-0.5 text-xs text-slate-200 truncate ${
          mono ? 'font-mono tabular-nums' : ''
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
