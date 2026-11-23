import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAlpacaBars,
  ProxyRequestError as AlpacaProxyRequestError,
} from '../api/alpacaApi';
import {
  fetchCandles as fetchDeltaCandles,
  ProxyRequestError as DeltaProxyRequestError,
} from '../api/deltaApi';
import type { AlpacaFeed } from '../contracts/alpaca';
import type { CandlePriceBasis } from '../contracts/delta';
import {
  evaluateDetector,
  type DetectorEvaluationReport,
} from '../engine/evaluation';
import type { CandlePoint } from '../engine/regime';

/**
 * Hard cap on total historical bars evaluated in one manual audit run.
 * Keeps browser computation instantaneous and Delta/Alpaca pagination bounded.
 */
export const EVALUATION_MAX_TOTAL_BARS = 5000;

export type EvaluationSource = 'delta' | 'alpaca';
export type EvaluationTimeframe = '15m' | '1h';

export interface EvaluationWindowConfig {
  lookbackDays: number;
  chunkDays: number;
  barIntervalMinutes: number;
  apiTimeframe: string;
  label: string;
}

/**
 * Documented lookback and pagination chunk windows for Delta Exchange India.
 * Delta /v2/history/candles caps single responses at 4,000 bars; 13-day (15m)
 * and 52-day (1h) chunks request ~1,248 bars per call safely below that cap.
 */
export const DELTA_EVALUATION_WINDOWS: Record<EvaluationTimeframe, EvaluationWindowConfig> = {
  '15m': {
    lookbackDays: 52,
    chunkDays: 13,
    barIntervalMinutes: 15,
    apiTimeframe: '15m',
    label: '15m · 52d lookback (4 × 13d chunks)',
  },
  '1h': {
    lookbackDays: 208,
    chunkDays: 52,
    barIntervalMinutes: 60,
    apiTimeframe: '1h',
    label: '1h · 208d lookback (4 × 52d chunks)',
  },
};

/**
 * Documented lookback and pagination chunk windows for Alpaca Market Data
 * when server credentials are configured.
 */
export const ALPACA_EVALUATION_WINDOWS: Record<EvaluationTimeframe, EvaluationWindowConfig> = {
  '15m': {
    lookbackDays: 52,
    chunkDays: 13,
    barIntervalMinutes: 15,
    apiTimeframe: '15Min',
    label: '15Min · 52d lookback (4 × 13d chunks)',
  },
  '1h': {
    lookbackDays: 208,
    chunkDays: 52,
    barIntervalMinutes: 60,
    apiTimeframe: '1Hour',
    label: '1Hour · 208d lookback (4 × 52d chunks)',
  },
};

export interface EvaluationProgress {
  completedWindows: number;
  totalWindows: number;
  barsLoaded: number;
}

export interface EvaluationFetchError {
  message: string;
  status: number | null;
  code: string | null;
  timestamp: string;
}

interface UseEvaluationHistoryParams {
  source: EvaluationSource;
  symbol: string | null;
  timeframe: EvaluationTimeframe;
  basis?: CandlePriceBasis;
  alpacaFeed?: AlpacaFeed;
  alpacaConfigured?: boolean | null;
  onAfterAlpacaRequest?: () => void;
  onCompleted?: (report: DetectorEvaluationReport) => void;
}

export interface UseEvaluationHistoryResult {
  report: DetectorEvaluationReport | null;
  candles: readonly CandlePoint[];
  isLoading: boolean;
  progress: EvaluationProgress | null;
  error: EvaluationFetchError | null;
  sourceLabel: string | null;
  fetchedAt: string | null;
  windowConfig: EvaluationWindowConfig;
  runEvaluation: () => Promise<void>;
  clearEvaluation: () => void;
}

export function useEvaluationHistory({
  source,
  symbol,
  timeframe,
  basis = 'trade',
  alpacaFeed,
  alpacaConfigured = null,
  onAfterAlpacaRequest,
  onCompleted,
}: UseEvaluationHistoryParams): UseEvaluationHistoryResult {
  const [report, setReport] = useState<DetectorEvaluationReport | null>(null);
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<EvaluationProgress | null>(null);
  const [error, setError] = useState<EvaluationFetchError | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const onAfterAlpacaRef = useRef(onAfterAlpacaRequest);
  onAfterAlpacaRef.current = onAfterAlpacaRequest;

  const windowConfig =
    source === 'delta'
      ? DELTA_EVALUATION_WINDOWS[timeframe]
      : ALPACA_EVALUATION_WINDOWS[timeframe];

  const clearEvaluation = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setReport(null);
    setCandles([]);
    setIsLoading(false);
    setProgress(null);
    setError(null);
    setSourceLabel(null);
    setFetchedAt(null);
  }, []);

  // Always clear results immediately when source, symbol, or timeframe changes
  useEffect(() => {
    clearEvaluation();
  }, [source, symbol, timeframe, basis, clearEvaluation]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const runEvaluation = useCallback(async () => {
    if (!symbol) {
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    // Never serve stale data while running or on failure
    setReport(null);
    setCandles([]);
    setError(null);
    setSourceLabel(null);
    setFetchedAt(null);

    if (source === 'alpaca' && alpacaConfigured !== true) {
      setIsLoading(false);
      setProgress(null);
      setError({
        message:
          'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment',
        status: 503,
        code: 'ALPACA_NOT_CONFIGURED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const totalSec = windowConfig.lookbackDays * 86_400;
    const chunkSec = windowConfig.chunkDays * 86_400;
    const endSec = Math.floor(Date.now() / 1000);
    const startSec = endSec - totalSec;

    const chunks: Array<{ start: number; end: number }> = [];
    for (let cursor = startSec; cursor < endSec; cursor += chunkSec) {
      const chunkEnd = Math.min(endSec, cursor + chunkSec);
      if (chunkEnd > cursor) {
        chunks.push({ start: cursor, end: chunkEnd });
      }
    }

    setIsLoading(true);
    setProgress({
      completedWindows: 0,
      totalWindows: chunks.length,
      barsLoaded: 0,
    });

    try {
      const byTime = new Map<number, CandlePoint>();
      let lastSource: string | null = null;
      let lastFetchedAt: string | null = null;

      for (let i = 0; i < chunks.length; i += 1) {
        if (controller.signal.aborted) return;
        const chunk = chunks[i];

        if (source === 'delta') {
          const env = await fetchDeltaCandles(
            {
              symbol,
              resolution: timeframe,
              start: chunk.start,
              end: chunk.end,
              basis,
            },
            controller.signal,
          );
          lastSource = env.source;
          lastFetchedAt = env.fetchedAt;
          for (const bar of env.data.candles) {
            if (
              Number.isFinite(bar.time) &&
              Number.isFinite(bar.open) &&
              Number.isFinite(bar.high) &&
              Number.isFinite(bar.low) &&
              Number.isFinite(bar.close)
            ) {
              byTime.set(bar.time, bar);
            }
          }
        } else {
          const env = await fetchAlpacaBars(
            {
              symbol,
              timeframe: timeframe === '15m' ? '15Min' : '1Hour',
              start: new Date(chunk.start * 1000).toISOString(),
              end: new Date(chunk.end * 1000).toISOString(),
              feed: alpacaFeed,
            },
            controller.signal,
          );
          lastSource = env.source;
          lastFetchedAt = env.data.fetchedAt || env.fetchedAt;
          onAfterAlpacaRef.current?.();
          for (const bar of env.data.bars) {
            if (
              Number.isFinite(bar.time) &&
              Number.isFinite(bar.open) &&
              Number.isFinite(bar.high) &&
              Number.isFinite(bar.low) &&
              Number.isFinite(bar.close)
            ) {
              byTime.set(bar.time, bar);
            }
          }
        }

        if (controller.signal.aborted) return;
        setProgress({
          completedWindows: i + 1,
          totalWindows: chunks.length,
          barsLoaded: Math.min(byTime.size, EVALUATION_MAX_TOTAL_BARS),
        });
      }

      const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
      const bounded =
        sorted.length > EVALUATION_MAX_TOTAL_BARS
          ? sorted.slice(sorted.length - EVALUATION_MAX_TOTAL_BARS)
          : sorted;

      if (bounded.length === 0) {
        setError({
          message: `No historical candles returned for ${symbol} (${windowConfig.label}).`,
          status: null,
          code: 'EMPTY_HISTORY',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const computed = evaluateDetector(bounded, {
        barIntervalMinutes: windowConfig.barIntervalMinutes,
      });

      if (controller.signal.aborted) return;

      setCandles(bounded);
      setReport(computed);
      setSourceLabel(lastSource);
      setFetchedAt(lastFetchedAt ?? new Date().toISOString());
      onCompletedRef.current?.(computed);
    } catch (err) {
      if (controller.signal.aborted) return;
      setCandles([]);
      setReport(null);
      if (err instanceof DeltaProxyRequestError || err instanceof AlpacaProxyRequestError) {
        setError({
          message: err.message,
          status: err.status,
          code: err.code,
          timestamp: err.timestamp,
        });
      } else {
        setError({
          message: err instanceof Error ? err.message : 'Failed to load evaluation history',
          status: null,
          code: null,
          timestamp: new Date().toISOString(),
        });
      }
      if (source === 'alpaca') {
        onAfterAlpacaRef.current?.();
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [symbol, source, timeframe, basis, alpacaFeed, alpacaConfigured, windowConfig]);

  return {
    report,
    candles,
    isLoading,
    progress,
    error,
    sourceLabel,
    fetchedAt,
    windowConfig,
    runEvaluation,
    clearEvaluation,
  };
}
