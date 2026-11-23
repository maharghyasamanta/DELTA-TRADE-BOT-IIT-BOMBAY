import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  ALPACA_TIMEFRAMES,
  type AlpacaTimeframe,
  type NormalizedCandle,
} from '../contracts/alpaca';
import { formatNumber, formatPrice, formatTimestamp } from '../utils/format';

export interface AlpacaBarsChartError {
  message: string;
  timestamp: string;
  code?: string;
}

interface AlpacaBarsChartProps {
  symbol: string | null;
  timeframe: AlpacaTimeframe;
  onChangeTimeframe: (tf: AlpacaTimeframe) => void;
  candles: NormalizedCandle[];
  isLoading: boolean;
  error: AlpacaBarsChartError | null;
  source: string | null;
  fetchedAt: string | null;
  feed: string | null;
  onRetry: () => void;
  onSwitchToIex?: () => void;
}

const NOT_CONFIGURED_MESSAGE =
  'Alpaca not configured — set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in your server environment';

function formatFeedLabel(feed: string | null): string {
  if (feed === 'iex') return 'IEX (15-min delay)';
  if (feed === 'sip') return 'SIP (real-time)';
  if (!feed) return 'plan default (feed not reported by Alpaca)';
  return feed;
}

export function AlpacaBarsChart({
  symbol,
  timeframe,
  onChangeTimeframe,
  candles,
  isLoading,
  error,
  source,
  fetchedAt,
  feed,
  onRetry,
  onSwitchToIex,
}: AlpacaBarsChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [hoveredCandle, setHoveredCandle] = useState<NormalizedCandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 440,
      layout: {
        background: { type: ColorType.Solid, color: '#0B1120' },
        textColor: '#94A3B8',
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(56, 189, 248, 0.45)', labelBackgroundColor: '#1E293B' },
        horzLine: { color: 'rgba(56, 189, 248, 0.45)', labelBackgroundColor: '#1E293B' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#16A34A',
      downColor: '#DC2626',
      borderVisible: false,
      wickUpColor: '#22C55E',
      wickDownColor: '#EF4444',
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHoveredCandle(null);
        return;
      }
      const ohlc = param.seriesData.get(candleSeries) as CandlestickData<UTCTimestamp> | undefined;
      const vol = param.seriesData.get(volumeSeries) as HistogramData<UTCTimestamp> | undefined;
      if (ohlc && typeof param.time === 'number') {
        setHoveredCandle({
          time: param.time,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          volume: vol?.value ?? 0,
        });
      }
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) {
      return;
    }

    if (!symbol || error) {
      candleSeriesRef.current.setData([]);
      volumeSeriesRef.current.setData([]);
      return;
    }

    const ohlcData: CandlestickData<UTCTimestamp>[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    const volData: HistogramData<UTCTimestamp>[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
    }));

    candleSeriesRef.current.setData(ohlcData);
    volumeSeriesRef.current.setData(volData);

    if (candles.length > 0) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles, symbol, error]);

  const activeBar = hoveredCandle || candles[candles.length - 1] || null;
  const activeBarTimeLabel = activeBar
    ? new Date(activeBar.time * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '—';

  const errorMessage =
    error?.code === 'ALPACA_NOT_CONFIGURED' ? NOT_CONFIGURED_MESSAGE : error?.message;

  return (
    <section
      aria-label="Alpaca Bars Chart"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Timeframe Segmented Buttons */}
          <div className="flex items-center gap-0.5 rounded-md border border-slate-800 bg-[#0B1120] p-0.5">
            {ALPACA_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => onChangeTimeframe(tf)}
                className={`rounded px-2.5 py-1 font-mono text-xs font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                  timeframe === tf
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={isLoading || !symbol}
            title="Reload Alpaca bars"
            className="rounded-md border border-slate-800 bg-[#0B1120] p-1.5 text-slate-400 hover:border-slate-700 hover:text-slate-200 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Conditional IEX Delay Banner */}
      {feed === 'iex' && (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-950/30 px-5 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>⚠ IEX feed — data may be delayed up to 15 minutes</span>
        </div>
      )}

      {/* OHLCV Readout Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/60 bg-[#0B1120]/60 px-5 py-2 font-mono text-xs tabular-nums">
        <div className="flex flex-wrap items-center gap-4 text-slate-300">
          <span className="text-slate-400">{activeBarTimeLabel}</span>
          <span>
            O <span className="text-slate-100">{formatPrice(activeBar?.open)}</span>
          </span>
          <span>
            H <span className="text-slate-100">{formatPrice(activeBar?.high)}</span>
          </span>
          <span>
            L <span className="text-slate-100">{formatPrice(activeBar?.low)}</span>
          </span>
          <span>
            C <span className="text-slate-100">{formatPrice(activeBar?.close)}</span>
          </span>
          <span>
            V <span className="text-slate-100">{formatNumber(activeBar?.volume, 2)}</span>
          </span>
        </div>
        <span className="text-[11px] text-slate-400">
          {candles.length} bars · {symbol || '—'}
        </span>
      </div>

      {/* Chart Canvas Area */}
      <div className="relative h-[440px] w-full bg-[#0B1120]">
        <div ref={containerRef} className="h-full w-full" />

        {!symbol && !error && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/95 p-6 text-center text-xs text-slate-400">
            Select a symbol to view Alpaca data
          </div>
        )}

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/85 text-xs text-slate-300">
            <div className="flex items-center gap-2 font-mono">
              <RefreshCw className="h-4 w-4 animate-spin text-sky-400" />
              <span>Fetching real historical bars from Alpaca Market Data...</span>
            </div>
          </div>
        )}

        {!isLoading && error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/95 p-6">
            <div className="max-w-md rounded-md border border-rose-500/30 bg-rose-950/20 p-4 text-xs text-rose-200">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div className="space-y-1.5">
                  <p className="font-medium text-rose-100">Alpaca data unavailable</p>
                  <p className="text-rose-300/90">{errorMessage}</p>
                  <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                    At {formatTimestamp(error.timestamp)}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {error.code === 'PLAN_RESTRICTION' && onSwitchToIex && (
                      <button
                        type="button"
                        onClick={onSwitchToIex}
                        className="rounded border border-amber-500/40 bg-amber-950/40 px-3 py-1 text-xs font-medium text-amber-200 hover:bg-amber-900/40 cursor-pointer"
                      >
                        Switch to IEX
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onRetry}
                      className="rounded border border-rose-500/40 px-3 py-1 text-xs font-medium text-rose-100 hover:bg-rose-900/40 cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && candles.length === 0 && symbol && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/90 p-6 text-center">
            <div className="max-w-md space-y-2 text-xs text-slate-300">
              <p className="font-medium text-slate-100">No bars returned by Alpaca Market Data</p>
              <p className="text-slate-400">
                Symbol <span className="font-mono text-slate-200">{symbol}</span> returned 0 bars for{' '}
                {timeframe} over the selected window.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Provenance Footer Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 text-[11px] text-slate-400">
        <span>
          Source: {source ? `Alpaca (${source})` : 'Alpaca'} · Feed: {formatFeedLabel(feed)}
        </span>
        <span className="font-mono tabular-nums">
          Last updated: {formatTimestamp(fetchedAt)}
        </span>
      </div>
    </section>
  );
}
