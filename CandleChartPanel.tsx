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
import { AlertCircle, RefreshCw } from 'lucide-react';
import type {
  CandlePriceBasis,
  CandleResolution,
  DeltaCandle,
} from '../contracts/delta';
import { formatNumber, formatPrice, formatTimestamp, getTickDecimals } from '../utils/format';

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

export const CHART_RESOLUTIONS: readonly CandleResolution[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
] as const;

interface CandleChartPanelProps {
  symbol: string | null;
  tickSize: string | number | null;
  resolution: CandleResolution;
  onChangeResolution: (res: CandleResolution) => void;
  lookbackId: string;
  onChangeLookback: (id: string) => void;
  basis: CandlePriceBasis;
  onChangeBasis: (basis: CandlePriceBasis) => void;
  candles: DeltaCandle[];
  liveCandle: DeltaCandle | null;
  isLoading: boolean;
  error: { message: string; timestamp: string } | null;
  source: string | null;
  fetchedAt: string | null;
  querySymbol: string | null;
  onRetry: () => void;
}

export function CandleChartPanel({
  symbol,
  tickSize,
  resolution,
  onChangeResolution,
  lookbackId,
  onChangeLookback,
  basis,
  onChangeBasis,
  candles,
  liveCandle,
  isLoading,
  error,
  source,
  fetchedAt,
  querySymbol,
  onRetry,
}: CandleChartPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastBarTimeRef = useRef<number>(0);

  const [hoveredCandle, setHoveredCandle] = useState<DeltaCandle | null>(null);

  const decimals = getTickDecimals(tickSize);
  const minMove = decimals > 0 ? Number((1 / Math.pow(10, decimals)).toFixed(decimals)) : 1;

  // Initialize TradingView Lightweight Charts instance once
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

  // Sync tick precision when instrument changes
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    candleSeriesRef.current.applyOptions({
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove,
      },
    });
  }, [decimals, minMove]);

  // Populate historical candle series
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) {
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
      color: c.close >= c.open ? 'rgba(22, 163, 74, 0.35)' : 'rgba(220, 38, 38, 0.35)',
    }));

    candleSeriesRef.current.setData(ohlcData);
    volumeSeriesRef.current.setData(volData);
    lastBarTimeRef.current = candles.length > 0 ? candles[candles.length - 1].time : 0;

    if (candles.length > 0) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles]);

  // Merge streaming WebSocket candle ticks
  useEffect(() => {
    if (!liveCandle || !candleSeriesRef.current || !volumeSeriesRef.current) {
      return;
    }
    if (liveCandle.time < lastBarTimeRef.current) {
      return;
    }
    lastBarTimeRef.current = liveCandle.time;

    candleSeriesRef.current.update({
      time: liveCandle.time as UTCTimestamp,
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });

    volumeSeriesRef.current.update({
      time: liveCandle.time as UTCTimestamp,
      value: liveCandle.volume,
      color:
        liveCandle.close >= liveCandle.open
          ? 'rgba(22, 163, 74, 0.35)'
          : 'rgba(220, 38, 38, 0.35)',
    });
  }, [liveCandle]);

  const activeBar = hoveredCandle || liveCandle || candles[candles.length - 1] || null;
  const activeBarTimeLabel = activeBar
    ? new Date(activeBar.time * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '—';

  return (
    <section
      aria-label="Real Candle Chart"
      className="flex flex-col rounded-lg border border-slate-800/90 bg-[#111A2E]"
    >
      {/* Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Resolution Segmented Buttons */}
          <div className="flex items-center gap-0.5 rounded-md border border-slate-800 bg-[#0B1120] p-0.5">
            {CHART_RESOLUTIONS.map((res) => (
              <button
                key={res}
                type="button"
                onClick={() => onChangeResolution(res)}
                className={`rounded px-2.5 py-1 font-mono text-xs font-medium transition-colors duration-150 cursor-pointer ${
                  resolution === res
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {res}
              </button>
            ))}
          </div>

          {/* Lookback Window Buttons */}
          <div className="flex items-center gap-0.5 rounded-md border border-slate-800 bg-[#0B1120] p-0.5">
            {LOOKBACK_OPTIONS.map((lb) => (
              <button
                key={lb.id}
                type="button"
                onClick={() => onChangeLookback(lb.id)}
                className={`rounded px-2 py-1 font-mono text-xs font-medium transition-colors duration-150 cursor-pointer ${
                  lookbackId === lb.id
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lb.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Price Basis Toggle */}
          <div className="flex items-center gap-0.5 rounded-md border border-slate-800 bg-[#0B1120] p-0.5">
            <button
              type="button"
              onClick={() => onChangeBasis('trade')}
              className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                basis === 'trade'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Trade OHLC
            </button>
            <button
              type="button"
              onClick={() => onChangeBasis('mark')}
              className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 cursor-pointer ${
                basis === 'mark'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Mark OHLC
            </button>
          </div>

          <button
            type="button"
            onClick={onRetry}
            disabled={isLoading}
            title="Reload historical candles"
            className="rounded-md border border-slate-800 bg-[#0B1120] p-1.5 text-slate-400 hover:border-slate-700 hover:text-slate-200 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* OHLCV Readout Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/60 bg-[#0B1120]/60 px-5 py-2 font-mono text-xs tabular-nums">
        <div className="flex flex-wrap items-center gap-4 text-slate-300">
          <span className="text-slate-400">{activeBarTimeLabel}</span>
          <span>
            O <span className="text-slate-100">{formatPrice(activeBar?.open, tickSize)}</span>
          </span>
          <span>
            H <span className="text-slate-100">{formatPrice(activeBar?.high, tickSize)}</span>
          </span>
          <span>
            L <span className="text-slate-100">{formatPrice(activeBar?.low, tickSize)}</span>
          </span>
          <span>
            C <span className="text-slate-100">{formatPrice(activeBar?.close, tickSize)}</span>
          </span>
          <span>
            V <span className="text-slate-100">{formatNumber(activeBar?.volume, 2)}</span>
          </span>
        </div>
        <span className="text-[11px] text-slate-400">
          {candles.length} bars · {querySymbol || symbol || '—'}
        </span>
      </div>

      {/* Chart Canvas Area */}
      <div className="relative h-[440px] w-full bg-[#0B1120]">
        <div ref={containerRef} className="h-full w-full" />

        {isLoading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/85 text-xs text-slate-300">
            <div className="flex items-center gap-2 font-mono">
              <RefreshCw className="h-4 w-4 animate-spin text-sky-400" />
              <span>Fetching real historical candles from Delta Exchange India...</span>
            </div>
          </div>
        )}

        {!isLoading && error && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/95 p-6">
            <div className="max-w-md rounded-md border border-rose-500/30 bg-rose-950/20 p-4 text-xs text-rose-200">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div className="space-y-1.5">
                  <p className="font-medium text-rose-100">Candle data unavailable</p>
                  <p className="text-rose-300/90">{error.message}</p>
                  <p className="font-mono text-[11px] text-rose-400/80 tabular-nums">
                    At {formatTimestamp(error.timestamp)}
                  </p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-1 rounded border border-rose-500/40 px-3 py-1 text-xs font-medium text-rose-100 hover:bg-rose-900/40 cursor-pointer"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !error && candles.length === 0 && symbol && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0B1120]/90 p-6 text-center">
            <div className="max-w-md space-y-2 text-xs text-slate-300">
              <p className="font-medium text-slate-100">
                No {basis === 'trade' ? 'traded' : 'mark'} candles returned by Delta Exchange India
              </p>
              <p className="text-slate-400">
                Contract <span className="font-mono text-slate-200">{querySymbol || symbol}</span>{' '}
                returned 0 bars for {resolution} over the selected window.
              </p>
              {basis === 'trade' && (
                <button
                  type="button"
                  onClick={() => onChangeBasis('mark')}
                  className="mt-2 rounded border border-sky-500/40 bg-sky-950/30 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-900/40 cursor-pointer"
                >
                  Switch to Mark OHLC (MARK:{symbol})
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Provenance Footer Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 px-5 py-2.5 text-[11px] text-slate-400">
        <span>{source || 'Delta Exchange India REST /v2/history/candles'}</span>
        <span className="font-mono tabular-nums">
          Last updated: {formatTimestamp(fetchedAt)}
        </span>
      </div>
    </section>
  );
}
