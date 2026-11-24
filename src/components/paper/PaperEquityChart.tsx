import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { EquityPoint } from '../../contracts/paper';

interface PaperEquityChartProps {
  equityCurve: readonly EquityPoint[];
  startingBalance: number;
}

export function PaperEquityChart({ equityCurve, startingBalance }: PaperEquityChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 220,
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
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#38BDF8',
      topColor: 'rgba(56, 189, 248, 0.28)',
      bottomColor: 'rgba(56, 189, 248, 0.02)',
      lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = areaSeries;

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
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const deduped = new Map<number, number>();
    for (const pt of equityCurve) {
      if (Number.isFinite(pt.time) && Number.isFinite(pt.equity)) {
        deduped.set(pt.time, pt.equity);
      }
    }
    const sorted = Array.from(deduped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({
        time: time as UTCTimestamp,
        value,
      }));

    if (sorted.length === 1) {
      // Lightweight charts renders cleanly with >= 2 points
      sorted.unshift({
        time: (sorted[0].time - 60) as UTCTimestamp,
        value: startingBalance,
      });
    }

    series.setData(sorted);
    if (sorted.length > 0) {
      const latest = sorted[sorted.length - 1].value;
      const positive = latest >= startingBalance;
      series.applyOptions({
        lineColor: positive ? '#10B981' : '#F43F5E',
        topColor: positive ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.25)',
        bottomColor: positive ? 'rgba(16, 185, 129, 0.02)' : 'rgba(244, 63, 94, 0.02)',
      });
      chart.timeScale().fitContent();
    }
  }, [equityCurve, startingBalance]);

  return (
    <section className="rounded-lg border border-slate-800/90 bg-[#111A2E] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Simulated Equity Curve</h3>
          <p className="text-xs text-slate-400">
            Mark-to-market virtual USDT equity including locked margin, realized PnL, fees, and funding
          </p>
        </div>
        <span className="font-mono text-xs text-slate-400 tabular-nums">
          Points: {equityCurve.length}
        </span>
      </div>
      <div
        ref={containerRef}
        data-testid="paper-equity-chart"
        className="h-[220px] w-full overflow-hidden rounded border border-slate-800/80 bg-[#0B1120]"
      />
    </section>
  );
}
