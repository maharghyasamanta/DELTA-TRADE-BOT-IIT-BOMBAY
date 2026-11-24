import type { CandleResolution } from '../contracts/delta';

export type LookbackOption = {
  id: string;
  label: string;
  seconds: number;
};

export const LOOKBACK_OPTIONS: readonly LookbackOption[] = [
  { id: '6h', label: '6H', seconds: 6 * 3600 },
  { id: '24h', label: '24H', seconds: 24 * 3600 },
  { id: '3d', label: '3D', seconds: 3 * 86_400 },
  { id: '7d', label: '7D', seconds: 7 * 86_400 },
  { id: '30d', label: '30D', seconds: 30 * 86_400 },
] as const;

export const DELTA_CLIENT_RESOLUTION_SECONDS: Record<CandleResolution, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14_400,
  '6h': 21_600,
  '1d': 86_400,
};

export const DELTA_MAX_CANDLES_PER_QUERY = 4000;

export function isLookbackAllowedForResolution(
  resolution: CandleResolution,
  lookbackSeconds: number,
): boolean {
  const stepSec = DELTA_CLIENT_RESOLUTION_SECONDS[resolution];
  return lookbackSeconds <= DELTA_MAX_CANDLES_PER_QUERY * stepSec;
}

export function clampLookbackIdForResolution(
  resolution: CandleResolution,
  lookbackId: string,
): string {
  const current = LOOKBACK_OPTIONS.find((opt) => opt.id === lookbackId);
  if (current && isLookbackAllowedForResolution(resolution, current.seconds)) {
    return current.id;
  }
  const allowed = LOOKBACK_OPTIONS.filter((opt) =>
    isLookbackAllowedForResolution(resolution, opt.seconds),
  );
  return allowed[allowed.length - 1]?.id ?? '24h';
}
