import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchCandles,
  fetchHealth,
  fetchProducts,
  fetchTicker,
  subscribeDeltaStream,
} from './api/deltaApi';
import {
  CandleChartPanel,
  LOOKBACK_OPTIONS,
} from './components/CandleChartPanel';
import { ContractSpecsPanel } from './components/ContractSpecsPanel';
import { InstrumentPicker } from './components/InstrumentPicker';
import { LiveTickerStrip } from './components/LiveTickerStrip';
import { PhaseRoadmapStrip } from './components/PhaseRoadmapStrip';
import { TopBar } from './components/TopBar';
import type {
  CandlePriceBasis,
  CandleResolution,
  DeltaCandle,
  DeltaProductSummary,
  DeltaTickerSnapshot,
  DeltaWsConnectionState,
  HealthStatusResponse,
} from './contracts/delta';

interface ErrorState {
  message: string;
  timestamp: string;
}

export default function App() {
  const [activeSection, setActiveSection] = useState<'monitor' | 'specs' | 'roadmap'>('monitor');

  // Health telemetry
  const [health, setHealth] = useState<HealthStatusResponse | null>(null);
  const [wsStateOverride, setWsStateOverride] = useState<DeltaWsConnectionState | null>(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

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

  // Initial load + 30s health polling
  useEffect(() => {
    void loadHealth();
    void loadProducts();
    const timer = setInterval(() => {
      void loadHealth();
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadHealth, loadProducts]);

  // Reset ticker and candles cleanly when switching instrument
  const handleSelectSymbol = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setTicker(null);
    setCandles([]);
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

  const handleNavigate = useCallback((section: 'monitor' | 'specs' | 'roadmap') => {
    setActiveSection(section);
    const el = document.getElementById(section);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-[#0B1120] text-slate-100">
      <TopBar
        health={health}
        wsStateOverride={wsStateOverride}
        isCheckingHealth={isCheckingHealth}
        onRefreshHealth={() => void loadHealth()}
        activeSection={activeSection}
        onNavigate={handleNavigate}
      />

      <main
        id="monitor"
        className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-5 space-y-5"
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)] items-start">
          <InstrumentPicker
            products={products}
            underlyings={underlyings}
            selectedSymbol={selectedSymbol}
            onSelectSymbol={handleSelectSymbol}
            isLoading={productsLoading}
            error={productsError}
            source={productsSource}
            fetchedAt={productsFetchedAt}
            onRetry={() => void loadProducts()}
          />

          <div className="min-w-0 space-y-5">
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
            />
          </div>
        </div>

        <ContractSpecsPanel
          product={selectedProduct}
          source={productsSource}
          fetchedAt={productsFetchedAt}
        />

        <PhaseRoadmapStrip />
      </main>

      <footer className="border-t border-slate-800/80 bg-[#0B1120] px-6 py-4">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
          <span>Read-only. Not financial advice.</span>
          <span className="font-mono text-[11px] text-slate-500">
            Data proxied server-side from api.india.delta.exchange (public market data only)
          </span>
        </div>
      </footer>
    </div>
  );
}
