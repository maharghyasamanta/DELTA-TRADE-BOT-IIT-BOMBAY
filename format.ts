export function getTickDecimals(tickSize?: string | number | null): number {
  if (tickSize === null || tickSize === undefined) return 2;
  const str = String(tickSize).trim();
  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) return 0;
  const trimmed = str.slice(dotIdx + 1).replace(/0+$/, '');
  return Math.min(Math.max(trimmed.length, 0), 8);
}

export function formatPrice(
  value: number | null | undefined,
  tickSize?: string | number | null,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const decimals = tickSize !== undefined && tickSize !== null ? getTickDecimals(tickSize) : inferDecimals(value);
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function inferDecimals(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 1000) return 2;
  if (abs >= 10) return 3;
  if (abs >= 0.1) return 4;
  return 6;
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatCompactUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatNumber(value: number | null | undefined, maxDecimals = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value.toLocaleString('en-US', {
    maximumFractionDigits: maxDecimals,
  });
}

export function formatTimestamp(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return '—';
  const date = new Date(isoOrNull);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDateTimeUtc(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return '—';
  const date = new Date(isoOrNull);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function formatContractTypeLabel(contractType: string): string {
  switch (contractType) {
    case 'perpetual_futures':
      return 'Perpetual';
    case 'call_options':
      return 'Call Option';
    case 'put_options':
      return 'Put Option';
    case 'futures':
      return 'Future';
    default:
      return contractType;
  }
}
