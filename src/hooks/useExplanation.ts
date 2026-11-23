import { useCallback, useEffect, useRef, useState } from 'react';
import { ExplainProxyError, requestExplanation } from '../api/explainApi';
import type {
  ExplainSnapshotRequest,
  ExplainStructuredOutput,
} from '../contracts/explain';

export interface ExplanationErrorState {
  message: string;
  code: string;
  status: number | null;
  timestamp: string;
  offendingNumbers?: number[];
  matchedWords?: string[];
}

export interface UseExplanationResult {
  explanation: ExplainStructuredOutput | null;
  model: string | null;
  generatedAt: string | null;
  cached: boolean;
  isLoading: boolean;
  error: ExplanationErrorState | null;
  explain: () => Promise<void>;
  clear: () => void;
}

export function useExplanation(
  snapshot: ExplainSnapshotRequest | null,
  onAfterRequest?: () => void,
): UseExplanationResult {
  const [explanation, setExplanation] = useState<ExplainStructuredOutput | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ExplanationErrorState | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const onAfterRequestRef = useRef(onAfterRequest);
  onAfterRequestRef.current = onAfterRequest;

  const contextKey = snapshot
    ? `${snapshot.source}|${snapshot.symbol}|${snapshot.timeframe}|${snapshot.candleCount}|${snapshot.lastCandleTime ?? 'null'}`
    : 'none';

  // Clear stale explanation/error whenever source, symbol, timeframe, or loaded candles change
  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setExplanation(null);
    setModel(null);
    setGeneratedAt(null);
    setCached(false);
    setIsLoading(false);
    setError(null);
  }, [contextKey]);

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setExplanation(null);
    setModel(null);
    setGeneratedAt(null);
    setCached(false);
    setIsLoading(false);
    setError(null);
  }, []);

  const explain = useCallback(async () => {
    if (!snapshot) return;

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const envelope = await requestExplanation(snapshot, controller.signal);
      if (controller.signal.aborted) return;

      setExplanation(envelope.data.explanation);
      setModel(envelope.data.model);
      setGeneratedAt(envelope.data.generatedAt);
      setCached(envelope.cached);
      onAfterRequestRef.current?.();
    } catch (err) {
      if (controller.signal.aborted) return;

      setExplanation(null);
      setModel(null);
      setGeneratedAt(null);
      setCached(false);

      if (err instanceof ExplainProxyError) {
        setError({
          message: err.message,
          code: err.code,
          status: err.status,
          timestamp: err.timestamp,
          offendingNumbers: err.offendingNumbers,
          matchedWords: err.matchedWords,
        });
      } else {
        setError({
          message: err instanceof Error ? err.message : 'Failed to request explanation',
          code: 'EXPLAIN_REQUEST_FAILED',
          status: null,
          timestamp: new Date().toISOString(),
        });
      }
      onAfterRequestRef.current?.();
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [snapshot]);

  return {
    explanation,
    model,
    generatedAt,
    cached,
    isLoading,
    error,
    explain,
    clear,
  };
}
