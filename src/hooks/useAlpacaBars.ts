import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAlpacaBars, ProxyRequestError } from '../api/alpacaApi';
import type {
  AlpacaFeed,
  AlpacaTimeframe,
  NormalizedCandle,
} from '../contracts/alpaca';
import type { AlpacaBarsChartError } from '../components/AlpacaBarsChart';

export const ALPACA_LOOKBACK_MS: Record<AlpacaTimeframe, number> = {
  '1Min': 1 * 24 * 60 * 60 * 1000, // 1 day
  '5Min': 5 * 24 * 60 * 60 * 1000, // 5 days
  '15Min': 5 * 24 * 60 * 60 * 1000, // 5 days
  '1Hour': 30 * 24 * 60 * 60 * 1000, // 30 days
  '1Day': 365 * 24 * 60 * 60 * 1000, // 1 year
};

const NOT_CONFIGURED_MESSAGE =
  'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment';

interface UseAlpacaBarsParams {
  symbol: string | null;
  timeframe: AlpacaTimeframe;
  feed?: AlpacaFeed;
  configured: boolean | null;
  onAfterRequest?: () => void;
}

interface UseAlpacaBarsResult {
  candles: NormalizedCandle[];
  isLoading: boolean;
  error: AlpacaBarsChartError | null;
  source: string | null;
  fetchedAt: string | null;
  feed: string | null;
  refetch: () => void;
}

export function useAlpacaBars({
  symbol,
  timeframe,
  feed,
  configured,
  onAfterRequest,
}: UseAlpacaBarsParams): UseAlpacaBarsResult {
  const [candles, setCandles] = useState<NormalizedCandle[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AlpacaBarsChartError | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [resolvedFeed, setResolvedFeed] = useState<string | null>(feed ?? null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const onAfterRequestRef = useRef(onAfterRequest);
  onAfterRequestRef.current = onAfterRequest;

  const refetch = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (configured === false) {
      setCandles((prev) => (prev.length === 0 ? prev : []));
      setIsLoading(false);
      setError((prev) =>
        prev?.code === 'ALPACA_NOT_CONFIGURED'
          ? prev
          : {
              message: NOT_CONFIGURED_MESSAGE,
              timestamp: new Date().toISOString(),
              code: 'ALPACA_NOT_CONFIGURED',
            },
      );
      setSource(null);
      setFetchedAt(null);
      setResolvedFeed(feed ?? null);
      return;
    }

    if (!symbol) {
      setCandles((prev) => (prev.length === 0 ? prev : []));
      setIsLoading(false);
      setError(null);
      setSource(null);
      setFetchedAt(null);
      setResolvedFeed(feed ?? null);
      return;
    }

    const controller = new AbortController();
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - ALPACA_LOOKBACK_MS[timeframe]);

    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const envelope = await fetchAlpacaBars(
          {
            symbol,
            timeframe,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            feed,
          },
          controller.signal,
        );

        if (controller.signal.aborted) return;

        setCandles(envelope.data.bars);
        setSource(envelope.source);
        setFetchedAt(envelope.data.fetchedAt || envelope.fetchedAt);
        setResolvedFeed(envelope.data.feed);
        onAfterRequestRef.current?.();
      } catch (err) {
        if (controller.signal.aborted) return;

        setCandles([]);
        setResolvedFeed(feed ?? null);
        if (err instanceof ProxyRequestError) {
          setError({
            message: err.message,
            timestamp: err.timestamp,
            code: err.code,
          });
        } else {
          setError({
            message: err instanceof Error ? err.message : 'Failed to fetch Alpaca bars',
            timestamp: new Date().toISOString(),
          });
        }
        onAfterRequestRef.current?.();
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [symbol, timeframe, feed, configured, reloadNonce]);

  return {
    candles,
    isLoading,
    error,
    source,
    fetchedAt,
    feed: resolvedFeed,
    refetch,
  };
}
