import { useMemo } from 'react';
import {
  computeRegimeSeries,
  type CandlePoint,
  type RegimeOptions,
  type RegimeSeriesResult,
} from '../engine/regime';

/**
 * Memoized wrapper around computeRegimeSeries for already-loaded candles.
 * Performs zero network calls and zero side effects.
 */
export function useRegimeSeries(
  candles: readonly CandlePoint[],
  options?: RegimeOptions,
): RegimeSeriesResult {
  return useMemo(() => computeRegimeSeries(candles, options), [candles, options]);
}
