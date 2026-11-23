import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import {
  fetchAlpacaLatestTrade,
  fetchAlpacaStatus,
  pingAlpaca,
  ProxyRequestError,
} from './api/alpacaApi';
import { fetchExplainStatus } from './api/explainApi';
import {
  fetchCandles,
  fetchHealth,
  fetchProducts,
  fetchTicker,
  subscribeDeltaStream,
} from './api/deltaApi';
import { AlpacaBarsChart } from './components/AlpacaBarsChart';
import type { AlpacaLiveErrorState } from './components/AlpacaHealthBadge';
import { AlpacaQuotePanel } from './components/AlpacaQuotePanel';
import { AuthStatusControl } from './components/AuthStatusControl';
import {
  CandleChartPanel,
  LOOKBACK_OPTIONS,
} from './components/CandleChartPanel';
import { ContractSpecsPanel } from './components/ContractSpecsPanel';
import { DecisionLogPanel } from './components/DecisionLogPanel';
import { EvaluationPanel } from './components/EvaluationPanel';
import { ExplanationPanel } from './components/ExplanationPanel';
import { GuardrailPanel } from './components/GuardrailPanel';
import {
  InstrumentPicker,
  type MarketDataSource,
} from './components/InstrumentPicker';
import { LiveTickerStrip } from './components/LiveTickerStrip';
import { PhaseRoadmapStrip } from './components/PhaseRoadmapStrip';
import { RegimePanel } from './components/RegimePanel';
import { TopBar } from './components/TopBar';
import type {
  AlpacaFeed,
  AlpacaStatusResponse,
  AlpacaTimeframe,
} from './contracts/alpaca';
import type { ExplainStatusResponse } from './contracts/explain';
import type {
  CandlePriceBasis,
  CandleResolution,
  DeltaCandle,
  DeltaProductSummary,
  DeltaTickerSnapshot,
  DeltaWsConnectionState,
  HealthStatusResponse,
} from './contracts/delta';
import { useAlpacaBars } from './hooks/useAlpacaBars';
import { useFirebaseAuth } from './hooks/useFirebaseAuth';
import { useRegimeSeries } from './hooks/useRegimeSeries';
import { formatTimestamp } from './utils/format';

interface ErrorState {
  message: string;
  timestamp: string;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<'monitor' | 'specs' | 'roadmap'>('monitor');
  const [dataSource, setDataSource] = useState<MarketDataSource>('delta');

  // Health telemetry
  const [health, setHealth] = useState<HealthStatusResponse | null>(null);
  const [wsStateOverride, setWsStateOverride] = useState<DeltaWsConnectionState | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // Alpaca telemetry & state
  const [alpacaStatus, setAlpacaStatus] = useState<AlpacaStatusResponse | null>(null);
  const [isCheckingAlpaca, setIsCheckingAlpaca] = useState(false);
  const [alpacaStatusError, setAlpacaStatusError] = useState<string | null>(null);
  const [alpacaLiveError, setAlpacaLiveError] = useState<AlpacaLiveErrorState | null>(null);
  const [alpacaLiveSuccessAt, setAlpacaLiveSuccessAt] = useState<string | null>(null);
  const [alpacaBadgeHintNoSymbol, setAlpacaBadgeHintNoSymbol] = useState(false);
  const [alpacaSymbol, setAlpacaSymbol] = useState<string | null>(null);
  const [alpacaRecentSymbols, setAlpacaRecentSymbols] = useState<string[]>([]);
  const [alpacaTimeframe, setAlpacaTimeframe] = useState<AlpacaTimeframe>('1Day');
  const [alpacaFeed, setAlpacaFeed] = useState<AlpacaFeed | undefined>(undefined);
  const [explainStatus, setExplainStatus] = useState<ExplainStatusResponse | null>(null);
  const [phase5Status, setPhase5Status] = useState<{
    completed: boolean;
    errorMessage: string | null;
    summaryDetail: string | null;
  }>({ completed: false, errorMessage: null, summaryDetail: null });

  // Live products catalog
  const [products, setProducts] = useState<DeltaProductSummary[]>([]);
  const [underlyings, setUnderlyings] = useState<string[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<ErrorState | null>(null);
  const [productsSource, setProductsSource] = useState<string | null>(null);
  const [productsFetchedAt, setProductsFetchedAt] = useState<string | null>(null);

  // Selected instrument & chart parameters
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [resolution, setResolution] = useState<CandleResolution>('15m');
  const [lookbackId, setLookbackId] = useState<string>('24h');
  const [basis, setBasis] = useState<CandlePriceBasis>('trade');

  // Live ticker state
  const [ticker, setTicker] = useState<DeltaTickerSnapshot | null>(null);
  const [tickerLoading, setTickerLoading] = useState(false);
  const [tickerError, setTickerError] = useState<ErrorState | null>(null);
  const [tickerSource, setTickerSource] = useState<string | null>(null);
  const [tickerUpdatedAt, setTickerUpdatedAt] = useState<string | null>(null);

  // Historical + live candle state
  const [candles, setCandles] = useState<DeltaCandle[]>([]);
  const [liveCandle, setLiveCandle] = useState<DeltaCandle | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [candlesError, setCandlesError] = useState<ErrorState | null>(null);
  const [candlesSource, setCandlesSource] = useState<string | null>(null);
  const [candlesFetchedAt, setCandlesFetchedAt] = useState<string | null>(null);
  const [candlesQuerySymbol, setCandlesQuerySymbol] = useState<string | null>(null);

  const selectedProduct = useMemo(
    () => products.find((p) => p.symbol === selectedSymbol) ?? null,
    [products, selectedSymbol],
  );

  const activeAlpacaSymbol = dataSource === 'alpaca' ? alpacaSymbol : null;

  useEffect(() => {
    if (activeAlpacaSymbol) {
      setAlpacaBadgeHintNoSymbol(false);
    }
  }, [activeAlpacaSymbol]);

  const syncAlpacaStatusOnly = useCallback(async (): Promise<AlpacaStatusResponse | null> => {
    try {
      const status = await fetchAlpacaStatus();
      setAlpacaStatus(status);
      setAlpacaStatusError(null);
      return status;
    } catch (err) {
      setAlpacaStatusError(
        err instanceof Error ? err.message : 'Unable to reach /api/alpaca/status',
      );
      return null;
    }
  }, []);

  const hasAutoPingedAlpacaRef = useRef(false);

  const loadAlpacaStatus = useCallback(async () => {
    setIsCheckingAlpaca(true);
    try {
      const status = await syncAlpacaStatusOnly();
      if (
        status &&
        status.configured &&
        status.lastSuccessAt === null &&
        status.lastError === null &&
        !hasAutoPingedAlpacaRef.current
      ) {
        hasAutoPingedAlpacaRef.current = true;
        try {
          const pingRes = await pingAlpaca();
          await syncAlpacaStatusOnly();
          setAlpacaLiveError(null);
          setAlpacaLiveSuccessAt(pingRes.fetchedAt);
        } catch (err) {
          const errState: AlpacaLiveErrorState =
            err instanceof ProxyRequestError
              ? {
                  status: err.status,
                  code: err.code,
                  message: err.message,
                  timestamp: err.timestamp,
                }
              : {
                  status: null,
                  code: null,
                  message: err instanceof Error ? err.message : 'Alpaca ping failed',
                  timestamp: new Date().toISOString(),
                };
          await syncAlpacaStatusOnly();
          setAlpacaLiveSuccessAt(null);
          setAlpacaLiveError(errState);
        }
        return;
      }

      if (status && status.lastError === null && status.lastSuccessAt !== null) {
        setAlpacaLiveError(null);
      } else if (status && status.lastError !== null) {
        setAlpacaLiveSuccessAt(null);
      }
    } finally {
      setIsCheckingAlpaca(false);
    }
  }, [syncAlpacaStatusOnly]);

  const handleCheckAlpacaBadge = useCallback(async () => {
    if (alpacaStatus && !alpacaStatus.configured) {
      await loadAlpacaStatus();
      return;
    }

    setIsCheckingAlpaca(true);
    setAlpacaBadgeHintNoSymbol(false);
    setAlpacaLiveError(null);

    try {
      if (activeAlpacaSymbol) {
        const env = await fetchAlpacaLatestTrade(activeAlpacaSymbol);
        await syncAlpacaStatusOnly();
        setAlpacaLiveError(null);
        setAlpacaLiveSuccessAt(env.fetchedAt || new Date().toISOString());
      } else {
        const pingRes = await pingAlpaca();
        await syncAlpacaStatusOnly();
        setAlpacaLiveError(null);
        setAlpacaLiveSuccessAt(pingRes.fetchedAt || new Date().toISOString());
      }
    } catch (err) {
      const errState: AlpacaLiveErrorState =
        err instanceof ProxyRequestError
          ? {
              status: err.status,
              code: err.code,
              message: err.message,
              timestamp: err.timestamp,
            }
          : {
              status: null,
              code: null,
              message: err instanceof Error ? err.message : 'Alpaca live check failed',
              timestamp: new Date().toISOString(),
            };
      await syncAlpacaStatusOnly();
      setAlpacaLiveSuccessAt(null);
      setAlpacaLiveError(errState);
    } finally {
      setIsCheckingAlpaca(false);
    }
  }, [activeAlpacaSymbol, alpacaStatus, loadAlpacaStatus, syncAlpacaStatusOnly]);

  const loadExplainStatus = useCallback(async () => {
    try {
      const status = await fetchExplainStatus();
      setExplainStatus(status);
    } catch {
      setExplainStatus({
        configured: false,
        primaryModel: 'gemini-4-hydrogen',
        fallbackModel: 'gemini-3.1-flash-lite',
        primaryModelOk: null,
        fallbackModelOk: null,
        modelCheckError: null,
        lastSuccessAt: null,
        lastError: 'Unable to reach /api/explain/status',
        checkedAt: new Date().toISOString(),
      });
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setIsCheckingHealth(true);
    try {
      const h = await fetchHealth();
      setHealth(h);
    } catch {
      setHealth((prev) => ({
        ok: false,
        deltaRestOk: false,
        deltaRestLatencyMs: null,
        deltaWsState: prev?.deltaWsState ?? 'disconnected',
        lastRestSuccessAt: prev?.lastRestSuccessAt ?? null,
        lastWsMessageAt: prev?.lastWsMessageAt ?? null,
        lastError: 'Unable to reach local server /api/health',
        cacheStats: prev?.cacheStats ?? {
          productsCached: false,
          productsAgeMs: null,
          candleCacheEntries: 0,
        },
        checkedAt: new Date().toISOString(),
      }));
    } finally {
      setIsCheckingHealth(false);
    }
  }, []);

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    setProductsError(null);
    try {
      const env = await fetchProducts();
      setProducts(env.data.products);
      setUnderlyings(env.data.underlyings);
      setProductsSource(env.source);
      setProductsFetchedAt(env.fetchedAt);

      setSelectedSymbol((prev) => {
        if (prev && env.data.products.some((p) => p.symbol === prev)) {
          return prev;
        }
        const firstPerp = env.data.products.find(
          (p) => p.contractType === 'perpetual_futures' && p.tradingStatus === 'operational',
        );
        return firstPerp?.symbol ?? env.data.products[0]?.symbol ?? null;
      });
    } catch (err) {
      setProductsError({
        message: err instanceof Error ? err.message : 'Failed to fetch live products',
        timestamp: new Date().toISOString(),
      });
    } finally {
      setProductsLoading(false);
    }
  }, []);

  const loadTicker = useCallback(async (symbol: string, signal?: AbortSignal) => {
    setTickerLoading(true);
    setTickerError(null);
    try {
      const env = await fetchTicker(symbol, signal);
      setTicker(env.data);
      setTickerSource(env.source);
      setTickerUpdatedAt(env.fetchedAt);
    } catch (err) {
      if (signal?.aborted) return;
      setTickerError({
        message: err instanceof Error ? err.message : 'Failed to load ticker',
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (!signal?.aborted) {
        setTickerLoading(false);
      }
    }
  }, []);

  const loadCandles = useCallback(
    async (
      symbol: string,
      res: CandleResolution,
      lbId: string,
      priceBasis: CandlePriceBasis,
      signal?: AbortSignal,
    ) => {
      setCandlesLoading(true);
      setCandlesError(null);
      setLiveCandle(null);

      const lookbackSec =
        LOOKBACK_OPTIONS.find((opt) => opt.id === lbId)?.seconds ?? 24 * 3600;
      const end = Math.floor(Date.now() / 1000);
      const start = end - lookbackSec;

      try {
        const env = await fetchCandles(
          {
            symbol,
            resolution: res,
            start,
            end,
            basis: priceBasis,
          },
          signal,
        );
        setCandles(env.data.candles);
        setCandlesQuerySymbol(env.data.querySymbol);
        setCandlesSource(env.source);
        setCandlesFetchedAt(env.fetchedAt);
      } catch (err) {
        if (signal?.aborted) return;
        setCandles([]);
        setCandlesError({
          message: err instanceof Error ? err.message : 'Failed to load candles',
          timestamp: new Date().toISOString(),
        });
      } finally {
        if (!signal?.aborted) {
          setCandlesLoading(false);
        }
      }
    },
    [],
  );

  // Initial load + 30s health polling (Delta + Alpaca + Explain)
  useEffect(() => {
    void loadHealth();
    void loadAlpacaStatus();
    void loadExplainStatus();
    void loadProducts();
    const timer = setInterval(() => {
      void loadHealth();
      void loadAlpacaStatus();
      void loadExplainStatus();
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadHealth, loadAlpacaStatus, loadExplainStatus, loadProducts]);

  const handleChangeDataSource = useCallback(
    (nextSource: MarketDataSource) => {
      setDataSource(nextSource);
      void loadAlpacaStatus();
    },
    [loadAlpacaStatus],
  );

  const handleSelectAlpacaSymbol = useCallback((symbol: string) => {
    setAlpacaSymbol(symbol);
    setAlpacaBadgeHintNoSymbol(false);
    setAlpacaLiveError(null);
    setAlpacaLiveSuccessAt(null);
    setAlpacaRecentSymbols((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
  }, []);

  const alpacaBars = useAlpacaBars({
    symbol: dataSource === 'alpaca' ? alpacaSymbol : null,
    timeframe: alpacaTimeframe,
    feed: alpacaFeed,
    configured: alpacaStatus ? alpacaStatus.configured : null,
    onAfterRequest: loadAlpacaStatus,
  });

  const deltaDisplayCandles = useMemo(() => {
    if (!liveCandle) return candles;
    if (candles.length === 0) return [liveCandle];
    const last = candles[candles.length - 1];
    if (liveCandle.time < last.time) return candles;
    if (liveCandle.time === last.time) {
      return [...candles.slice(0, -1), liveCandle];
    }
    return [...candles, liveCandle];
  }, [candles, liveCandle]);

  const activeCandles = useMemo(
    () => (dataSource === 'delta' ? deltaDisplayCandles : alpacaBars.candles),
    [dataSource, deltaDisplayCandles, alpacaBars.candles],
  );

  const regimeResult = useRegimeSeries(activeCandles);
  const firebaseAuth = useFirebaseAuth();

  // Reset ticker and candles cleanly when switching instrument
  const handleSelectSymbol = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setTicker(null);
    setTickerError(null);
    setCandles([]);
    setCandlesError(null);
    setLiveCandle(null);
    setBasis('trade');
  }, []);

  // Load REST ticker + candles and subscribe to server-bridged WebSocket SSE
  useEffect(() => {
    if (!selectedSymbol) return;
    const controller = new AbortController();

    void loadTicker(selectedSymbol, controller.signal);
    void loadCandles(selectedSymbol, resolution, lookbackId, basis, controller.signal);

    const unsubscribe = subscribeDeltaStream({
      symbol: selectedSymbol,
      resolution,
      basis,
      onEvent: (event) => {
        if (event.type === 'health') {
          setWsStateOverride(event.wsState);
        } else if (event.type === 'ticker' && event.symbol === selectedSymbol) {
          setTicker(event.ticker);
          setTickerSource(event.source);
          setTickerUpdatedAt(event.timestamp);
          setTickerError(null);
        } else if (
          event.type === 'candle' &&
          event.symbol === selectedSymbol &&
          event.resolution === resolution &&
          event.basis === basis
        ) {
          setLiveCandle(event.candle);
          setCandlesSource(event.source);
          setCandlesFetchedAt(event.timestamp);
        } else if (event.type === 'error') {
          setWsStateOverride('error');
        }
      },
      onTransportError: () => {
        setWsStateOverride('reconnecting');
      },
    });

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [selectedSymbol, resolution, lookbackId, basis, loadTicker, loadCandles]);

  const pendingSectionRef = useRef<'monitor' | 'specs' | 'roadmap' | null>(null);

  const handleNavigate = useCallback(
    (section: 'monitor' | 'specs' | 'roadmap') => {
      setActiveSection(section);
      if (section === 'specs' && dataSource !== 'delta') {
        pendingSectionRef.current = 'specs';
        setDataSource('delta');
        return;
      }
      const el = document.getElementById(section);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [dataSource],
  );

  useEffect(() => {
    if (pendingSectionRef.current === 'specs' && dataSource === 'delta') {
      pendingSectionRef.current = null;
      requestAnimationFrame(() => {
        const el = document.getElementById('specs');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  }, [dataSource]);

  return (
    <div className="min-h-screen flex flex-col bg-[#0B1120] text-slate-100">
      <TopBar
        health={health}
        wsStateOverride={wsStateOverride}
        isCheckingHealth={isCheckingHealth}
        onRefreshHealth={() => void loadHealth()}
        alpacaStatus={alpacaStatus}
        isCheckingAlpaca={isCheckingAlpaca}
        alpacaStatusError={alpacaStatusError}
        alpacaLiveError={alpacaLiveError}
        alpacaLiveSuccessAt={alpacaLiveSuccessAt}
        alpacaNeedsSymbolHint={alpacaBadgeHintNoSymbol}
        activeAlpacaSymbol={activeAlpacaSymbol}
        onRefreshAlpacaStatus={() => void handleCheckAlpacaBadge()}
        activeSection={activeSection}
        onNavigate={handleNavigate}
        authSlot={
          <AuthStatusControl
            user={firebaseAuth.user}
            authReady={firebaseAuth.authReady}
            isSigningIn={firebaseAuth.isSigningIn}
            authError={firebaseAuth.authError}
            isFirebaseConfigured={firebaseAuth.isFirebaseConfigured}
            firebaseConfigError={firebaseAuth.firebaseConfigError}
            onSignIn={() => void firebaseAuth.signInWithGoogle()}
            onSignOut={() => void firebaseAuth.signOutUser()}
          />
        }
      />

      <main
        id="monitor"
        className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 space-y-5 sm:px-6"
      >
        {firebaseAuth.authError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/35 bg-rose-950/25 px-4 py-3 text-xs text-rose-200"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-rose-100">Google Sign-In Error</p>
                  {firebaseAuth.authError.code && (
                    <span className="rounded border border-rose-500/40 bg-rose-950/60 px-1.5 py-0.5 font-mono text-[11px] text-rose-200">
                      {firebaseAuth.authError.code}
                    </span>
                  )}
                </div>
                <p className="break-words font-mono text-[11px] text-rose-200/95">
                  {firebaseAuth.authError.message}
                </p>
                {firebaseAuth.authError.isStorageBlocked && (
                  <p className="break-words text-[11px] text-amber-200/95">
                    Browser storage appears blocked inside this preview iframe — open the app in its
                    own tab with the fullscreen button so Google sign-in persists across reloads.
                  </p>
                )}
                <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                  At {formatTimestamp(firebaseAuth.authError.timestamp)}
                </p>
                {(firebaseAuth.authError.code === 'auth/unauthorized-domain' ||
                  firebaseAuth.authError.message.includes('auth/unauthorized-domain')) &&
                  typeof window !== 'undefined' && (
                    <p className="break-words text-[11px] text-rose-200">
                      Add this domain in Firebase Console -&gt; Authentication -&gt; Settings -&gt; Authorized domains:{' '}
                      <span className="font-mono font-semibold text-rose-50">
                        {window.location.hostname}
                      </span>
                    </p>
                  )}
              </div>
            </div>
            <button
              type="button"
              onClick={firebaseAuth.clearAuthError}
              aria-label="Dismiss sign-in error"
              className="rounded p-1 text-rose-300 hover:bg-rose-900/40 hover:text-rose-100 cursor-pointer shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {alpacaLiveError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/35 bg-rose-950/25 px-4 py-3 text-xs text-rose-200"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-rose-100">Alpaca Live Check Error</p>
                  {alpacaLiveError.status !== null && (
                    <span className="rounded border border-rose-500/40 bg-rose-950/60 px-1.5 py-0.5 font-mono text-[11px] text-rose-200">
                      HTTP {alpacaLiveError.status}
                    </span>
                  )}
                  {alpacaLiveError.code && (
                    <span className="rounded border border-rose-500/30 bg-rose-950/40 px-1.5 py-0.5 font-mono text-[11px] text-rose-300">
                      {alpacaLiveError.code}
                    </span>
                  )}
                </div>
                <p className="break-words font-mono text-[11px] text-rose-200/95">
                  {alpacaLiveError.message}
                </p>
                <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                  At {formatTimestamp(alpacaLiveError.timestamp)}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAlpacaLiveError(null)}
              aria-label="Dismiss Alpaca live check error"
              className="rounded p-1 text-rose-300 hover:bg-rose-900/40 hover:text-rose-100 cursor-pointer shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)] items-start">
          <InstrumentPicker
            dataSource={dataSource}
            onChangeDataSource={handleChangeDataSource}
            products={products}
            underlyings={underlyings}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={handleSelectSymbol}
            isLoading={productsLoading}
            error={productsError}
            source={productsSource}
            fetchedAt={productsFetchedAt}
            onRetry={() => void loadProducts()}
            alpacaSelectedSymbol={alpacaSymbol}
            alpacaRecentSymbols={alpacaRecentSymbols}
            alpacaConfigured={alpacaStatus ? alpacaStatus.configured : null}
            alpacaCheckedAt={alpacaStatus?.checkedAt ?? null}
            onSelectAlpacaSymbol={handleSelectAlpacaSymbol}
            onAfterAlpacaValidate={loadAlpacaStatus}
          />

          <div className="min-w-0 space-y-5">
            {dataSource === 'delta' ? (
              <>
                <LiveTickerStrip
                  symbol={selectedSymbol}
                  ticker={ticker}
                  isLoading={tickerLoading}
                  error={tickerError}
                  source={tickerSource}
                  lastUpdated={tickerUpdatedAt}
                  onRefresh={() => {
                    if (selectedSymbol) void loadTicker(selectedSymbol);
                  }}
                />

                <CandleChartPanel
                  symbol={selectedSymbol}
                  tickSize={selectedProduct?.tickSize ?? ticker?.tickSize ?? null}
                  resolution={resolution}
                  onChangeResolution={setResolution}
                  lookbackId={lookbackId}
                  onChangeLookback={setLookbackId}
                  basis={basis}
                  onChangeBasis={setBasis}
                  candles={candles}
                  liveCandle={liveCandle}
                  isLoading={candlesLoading}
                  error={candlesError}
                  source={candlesSource}
                  fetchedAt={candlesFetchedAt}
                  querySymbol={candlesQuerySymbol}
                  onRetry={() => {
                    if (selectedSymbol) {
                      void loadCandles(selectedSymbol, resolution, lookbackId, basis);
                    }
                  }}
                  markers={dataSource === 'delta' ? regimeResult.markers : undefined}
                />

                <RegimePanel
                  result={regimeResult}
                  sourceLabel="Delta"
                  timeframeLabel={`${resolution} (${lookbackId.toUpperCase()})`}
                  symbol={selectedSymbol}
                />

                <GuardrailPanel
                  regimeResult={regimeResult}
                  sourceLabel="Delta"
                  timeframeLabel={`${resolution} (${lookbackId.toUpperCase()})`}
                  symbol={selectedSymbol}
                  user={firebaseAuth.user}
                  authReady={firebaseAuth.authReady}
                  isFirebaseConfigured={firebaseAuth.isFirebaseConfigured}
                  onSignIn={() => void firebaseAuth.signInWithGoogle()}
                />

                <ExplanationPanel
                  regimeResult={regimeResult}
                  sourceLabel="Delta"
                  timeframeLabel={`${resolution} (${lookbackId.toUpperCase()})`}
                  symbol={selectedSymbol}
                  explainStatus={explainStatus}
                  onAfterRequest={() => void loadExplainStatus()}
                />

                <EvaluationPanel
                  source="delta"
                  symbol={selectedSymbol}
                  basis={basis}
                  onEvaluationStateChange={setPhase5Status}
                />
              </>
            ) : (
              <>
                {alpacaSymbol && (
                  <AlpacaQuotePanel
                    symbol={alpacaSymbol}
                    configured={alpacaStatus ? alpacaStatus.configured : null}
                    onAfterRequest={loadAlpacaStatus}
                  />
                )}

                {alpacaSymbol &&
                  !alpacaBars.isLoading &&
                  !alpacaBars.error &&
                  alpacaBars.candles.length === 0 && (
                    <div
                      role="status"
                      className="rounded-lg border border-slate-800/90 bg-[#111A2E] px-5 py-3 text-xs text-slate-300"
                    >
                      <span>
                        Alpaca returned 0 bars for {alpacaSymbol}, {alpacaTimeframe}, and{' '}
                        {alpacaFeed ?? 'plan default'}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span className="font-mono text-slate-400 tabular-nums">
                        At {formatTimestamp(alpacaBars.fetchedAt)}
                      </span>
                      <span className="text-slate-400">
                        {' '}
                        (the market may be closed or the window empty)
                      </span>
                    </div>
                  )}

                <AlpacaBarsChart
                  symbol={alpacaSymbol}
                  timeframe={alpacaTimeframe}
                  onChangeTimeframe={setAlpacaTimeframe}
                  candles={alpacaBars.candles}
                  isLoading={alpacaBars.isLoading}
                  error={alpacaBars.error}
                  source={alpacaBars.source}
                  fetchedAt={alpacaBars.fetchedAt}
                  feed={alpacaBars.feed}
                  onRetry={() => {
                    void loadAlpacaStatus();
                    alpacaBars.refetch();
                  }}
                  onSwitchToIex={() => setAlpacaFeed('iex')}
                  markers={dataSource === 'alpaca' ? regimeResult.markers : undefined}
                />

                <RegimePanel
                  result={regimeResult}
                  sourceLabel="Alpaca"
                  timeframeLabel={alpacaTimeframe}
                  symbol={alpacaSymbol}
                />

                <GuardrailPanel
                  regimeResult={regimeResult}
                  sourceLabel="Alpaca"
                  timeframeLabel={alpacaTimeframe}
                  symbol={alpacaSymbol}
                  user={firebaseAuth.user}
                  authReady={firebaseAuth.authReady}
                  isFirebaseConfigured={firebaseAuth.isFirebaseConfigured}
                  onSignIn={() => void firebaseAuth.signInWithGoogle()}
                />

                <ExplanationPanel
                  regimeResult={regimeResult}
                  sourceLabel="Alpaca"
                  timeframeLabel={alpacaTimeframe}
                  symbol={alpacaSymbol}
                  explainStatus={explainStatus}
                  onAfterRequest={() => void loadExplainStatus()}
                />

                <EvaluationPanel
                  source="alpaca"
                  symbol={alpacaSymbol}
                  alpacaFeed={alpacaFeed}
                  alpacaConfigured={alpacaStatus ? alpacaStatus.configured : null}
                  onAfterAlpacaRequest={() => void loadAlpacaStatus()}
                  onEvaluationStateChange={setPhase5Status}
                />
              </>
            )}
          </div>
        </div>

        {dataSource === 'delta' && (
          <ContractSpecsPanel
            product={selectedProduct}
            source={productsSource}
            fetchedAt={productsFetchedAt}
          />
        )}

        <DecisionLogPanel
          user={firebaseAuth.user}
          authReady={firebaseAuth.authReady}
          isFirebaseConfigured={firebaseAuth.isFirebaseConfigured}
          firebaseConfigError={firebaseAuth.firebaseConfigError}
          onSignIn={() => void firebaseAuth.signInWithGoogle()}
        />

        <PhaseRoadmapStrip
          firebaseConfigured={firebaseAuth.isFirebaseConfigured}
          isSignedIn={Boolean(firebaseAuth.user)}
          geminiConfigured={explainStatus ? explainStatus.configured : null}
          geminiVerified={Boolean(explainStatus?.lastSuccessAt)}
          explainStatus={explainStatus}
          phase5Completed={phase5Status.completed}
          phase5Error={phase5Status.errorMessage}
          phase5Detail={phase5Status.summaryDetail}
        />
      </main>

      <footer className="border-t border-slate-800/80 bg-[#0B1120] px-6 py-4">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <span>Read-only. Not financial advice.</span>
          <span className="font-mono text-[11px] text-slate-500">
            {dataSource === 'alpaca'
              ? 'Data proxied server-side from data.alpaca.markets (public market data only)'
              : 'Data proxied server-side from api.india.delta.exchange (public market data only)'}
          </span>
        </div>
      </footer>
    </div>
  );
}
