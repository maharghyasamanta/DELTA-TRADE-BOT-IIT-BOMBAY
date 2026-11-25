import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Battery,
  Clock,
  Coins,
  Database,
  LayoutGrid,
  Play,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingUp,
  TrendingDown,
  Zap,
} from 'lucide-react';

type AIDecision = {
  timestamp: string;
  action: string;
  action_code: number;
  reward: number;
  done: boolean;
  q_value: number;
  net_roi: number;
  position: number;
};

type Trade = {
  id: number;
  timestamp: string;
  symbol: string;
  side: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  pnl: number;
  pnl_pct: number;
  action: number | null;
  strategy: string | null;
  ml_confidence: number | null;
  dl_confidence: number | null;
  rl_confidence: number | null;
};

type EquityPoint = {
  episode: number;
  equity: number;
  date: string;
};

type Position = {
  symbol: string;
  side: string;
  entry_price: number;
  unrealized_pnl: number;
  contracts: number;
};

type AiMetrics = {
  win_rate: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_pnl: number;
  net_roi_pct: number;
  max_drawdown_pct: number;
  daily_target_achieved: boolean;
  target_pct: number;
  last_daily_net_usd: number;
};

type AiStatus = {
  ai_running: boolean;
  models_loaded: boolean;
  database_exists: boolean;
  last_updated: string | null;
  version: string;
};

const ACTION_LABEL_COLORS: Record<string, string> = {
  HOLD: 'bg-slate-700',
  LONG: 'bg-emerald-900/50 border-emerald-500/30 text-emerald-300',
  SHORT: 'bg-rose-900/50 border-rose-500/30 text-rose-300',
  FLATTEN: 'bg-amber-900/50 border-amber-500/30 text-amber-300',
};

const ACTION_LABEL_BORDER: Record<string, string> = {
  HOLD: 'border-slate-600',
  LONG: 'border-emerald-500/30',
  SHORT: 'border-rose-500/30',
  FLATTEN: 'border-amber-500/30',
};

export function AIDashboard() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [metrics, setMetrics] = useState<AiMetrics | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [decisions, setDecisions] = useState<AIDecision[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/status');
      if (r.ok) setStatus(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/metrics');
      if (r.ok) setMetrics(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchTrades = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/trades');
      if (r.ok) setTrades(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchEquity = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/equity-curve');
      if (r.ok) setEquity(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchDecisions = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/decisions');
      if (r.ok) setDecisions(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/positions');
      if (r.ok) setPositions(await r.json());
    } catch {
      // ignore
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchStatus(),
      fetchMetrics(),
      fetchTrades(),
      fetchEquity(),
      fetchDecisions(),
      fetchPositions(),
    ]);
    setLoading(false);
  }, [
    fetchStatus,
    fetchMetrics,
    fetchTrades,
    fetchEquity,
    fetchDecisions,
    fetchPositions,
  ]);

  useEffect(() => {
    void fetchAll();
    pollRef.current = setInterval(() => void fetchAll(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchAll]);

  const handleTrain = useCallback(async () => {
    try {
      const r = await fetch('/api/ai/train', { method: 'POST' });
      if (r.ok) {
        const result = await r.json();
        setError(null);
        alert('AI Training started: ' + (result.message ?? 'check console'));
      } else {
        setError('Failed to start training');
      }
    } catch {
      setError('Training request failed');
    }
  }, []);

  const totalPnl = metrics?.total_pnl ?? 0;
  const winRate = metrics?.win_rate ?? 0;
  const targetHit = metrics?.daily_target_achieved ?? false;
  const netRoi = metrics?.net_roi_pct ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Autonomous AI Trader
          </h1>
          <p className="text-sm text-slate-400">
            Live AI trading dashboard — ML • DL • RL • Paper Trading
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleTrain}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-emerald-600/20 border border-emerald-500/30 px-4 py-2 text-xs font-semibold text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            <Zap className="h-4 w-4" />{' '}
            {loading ? 'Training...' : 'Start AI Training'}
          </button>
          <button
            onClick={fetchAll}
            className="rounded-lg border border-slate-600/50 bg-slate-800/50 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-900/20 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Status Row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-4">
        <StatTile
          title="AI Status"
          value={status?.ai_running ? 'ACTIVE' : 'OFFLINE'}
          subvalue={
            status?.models_loaded && status?.database_exists
              ? 'Models + DB Loaded'
              : 'Initializing'
          }
          icon={<ShieldCheck className="h-5 w-5" />}
          iconColor={
            status?.ai_running ? 'text-emerald-400' : 'text-rose-400'
          }
          good={status?.ai_running ?? false}
        />
        <StatTile
          title="Win Rate"
          value={`${winRate.toFixed(1)}%`}
          subvalue={
            `${metrics?.winning_trades ?? 0}W / ${metrics?.losing_trades ?? 0}L`
          }
          icon={<Target className="h-5 w-5" />}
          iconColor="text-sky-400"
          good={winRate >= 55}
        />
        <StatTile
          title="Net ROI"
          value={`${netRoi.toFixed(2)}%`}
          subvalue={targetHit ? '10% Daily Target ✓' : 'Below Target'}
          icon={
            netRoi >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />
          }
          iconColor={netRoi >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          good={netRoi >= 0}
        />
        <StatTile
          title="Total PnL"
          value={`$${totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subvalue={`$${metrics?.last_daily_net_usd?.toFixed(2) ?? '0.00'} today`}
          icon={<Coins className="h-5 w-5" />}
          iconColor={totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          good={totalPnl >= 0}
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Chart + Decisions */}
        <div className="lg:col-span-7 space-y-6">
          <AICandlestickChart equity={equity} />
          <AIDecisionLog decisions={decisions} positions={positions} />
        </div>

        {/* Right: Metrics + Trades */}
        <div className="lg:col-span-5 space-y-6">
          <AiMetricsPanel metrics={metrics} status={status} />
          <ATradeLog trades={trades} />
        </div>
      </div>
    </div>
  );
}

function StatTile({
  title,
  value,
  subvalue,
  icon,
  iconColor,
  good,
}: {
  title: string;
  value: string;
  subvalue: string;
  icon: React.ReactNode;
  iconColor: string;
  good: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/60 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-slate-400 ${iconColor}`}>{icon}</span>
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</h3>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            good
              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
              : 'border-slate-600 bg-slate-800/50 text-slate-400'
          }`}
        >
          {good ? 'OK' : 'WARN'}
        </span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      <p className="mt-1 text-xs text-slate-400">{subvalue}</p>
    </div>
  );
}

function AICandlestickChart({ equity }: { equity: EquityPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Generate mock OHLCV with AI decision overlays
  const candles = useMemo(() => {
    const arr = [];
    let price = 100;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 120; i++) {
      const change = (Math.random() - 0.5) * 0.03;
      const open = price;
      price = price * (1 + change);
      const close = price;
      const high = Math.max(open, close) * (1 + Math.random() * 0.015);
      const low = Math.min(open, close) * (1 - Math.random() * 0.015);
      arr.push({
        time: now - (120 - i) * 300,
        open,
        high,
        low,
        close,
        volume: Math.random() * 100000,
        aiAction: i % 15 === 0 ? (i % 3 === 0 ? 'LONG' : i % 3 === 1 ? 'SHORT' : 'HOLD') : null,
      });
    }
    return arr;
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = 40;

    ctx.clearRect(0, 0, w, h);

    // Price scale
    const prices = candles.map((c) => c.close);
    const minPrice = Math.min(...prices) * 0.995;
    const maxPrice = Math.max(...prices) * 1.005;
    const priceRange = maxPrice - minPrice;

    const xStep = (w - pad * 2) / (candles.length - 1);

    // Draw grid
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (h - pad * 2) * (i / 4);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();

      const priceVal = minPrice + priceRange * (i / 4);
      ctx.fillStyle = '#6b7280';
      ctx.font = '10px system-ui';
      ctx.fillText(priceVal.toFixed(2), 8, y + 3);
    }

    // Draw candles
    candles.forEach((c, i) => {
      const x = pad + i * xStep;
      const isUp = c.close >= c.open;
      const bodyTop = h - pad - ((isUp ? c.close : c.open) - minPrice) / priceRange * (h - pad * 2);
      const bodyBottom = h - pad - ((isUp ? c.open : c.close) - minPrice) / priceRange * (h - pad * 2);
      const topWick = h - pad - (c.high - minPrice) / priceRange * (h - pad * 2);
      const bottomWick = h - pad - (c.low - minPrice) / priceRange * (h - pad * 2);

      ctx.fillStyle = isUp ? '#10b981' : '#ef4444';
      ctx.fillRect(x - 2, bodyTop, 4, Math.max(1, bodyBottom - bodyTop));
      ctx.fillRect(x - 0.5, topWick, 1, bodyTop - topWick);
      ctx.fillRect(x - 0.5, bodyBottom, 1, bottomWick - bodyBottom);

      // AI markers
      if (c.aiAction && hoverIdx === i) {
        ctx.fillStyle =
          c.aiAction === 'LONG' ? '#10b981' : c.aiAction === 'SHORT' ? '#ef4444' : '#6b7280';
        ctx.beginPath();
        ctx.arc(x, pad - 10, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Equity curve overlay (bottom)
    if (equity.length > 1) {
      const eqMin = Math.min(...equity.map((e) => e.equity));
      const eqMax = Math.max(...equity.map((e) => e.equity));
      const eqRange = eqMax - eqMin || 1;
      const eqYStart = h - pad + 20;
      const eqHeight = 60;

      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      equity.forEach((e, i) => {
        const x = pad + (i / Math.max(1, equity.length - 1)) * (w - pad * 2);
        const y = eqYStart + eqHeight - ((e.equity - eqMin) / eqRange) * eqHeight;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = '#6b7280';
      ctx.font = '10px system-ui';
      ctx.fillText('Equity Curve', pad, eqYStart - 5);
    }
  }, [candles, equity, hoverIdx]);

  return (
    <div className="rounded-xl border border-slate-700/50 bg-[#0B1120] p-4 shadow-sm relative overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">Live Chart — AI Decision Markers</h3>
        <div className="flex gap-2 text-[10px]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500" /> LONG
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-500" /> SHORT
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-500" /> HOLD
          </span>
        </div>
      </div>
      <div className="relative h-[320px] w-full">
        <canvas ref={canvasRef} className="w-full h-full block" />
        <div
          className="absolute inset-0 bg-transparent"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const idx = Math.floor(((x - 40) / (rect.width - 80)) * (candles.length - 1));
            setHoverIdx(Math.max(0, Math.min(candles.length - 1, idx)));
          }}
          onMouseLeave={() => setHoverIdx(null)}
        />
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        Canvas candlestick chart with AI buy/sell markers. Hover to see AI decisions.
      </p>
    </div>
  );
}

function AIDecisionLog({
  decisions,
  positions,
}: {
  decisions: AIDecision[];
  positions: Position[];
}) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-[#0B1120] p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">AI Decisions (Live)</h3>
        <span className="text-[10px] font-mono text-slate-500">Updates every 5s</span>
      </div>

      {/* Current Positions */}
      {positions.length > 0 && (
        <div className="mb-4 p-3 rounded-lg border border-emerald-500/20 bg-emerald-900/10">
          <h4 className="text-xs font-semibold text-emerald-400 mb-2">Current Position</h4>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-slate-400">Symbol</span>
              <div className="text-slate-200 font-mono">{positions[0].symbol}</div>
            </div>
            <div>
              <span className="text-slate-400">Side</span>
              <div className={`text-slate-200 font-mono ${positions[0].side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}`}>
                {positions[0].side}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Entry</span>
              <div className="text-slate-200 font-mono">${positions[0].entry_price.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-slate-400">Unrealized</span>
              <div className={`text-slate-200 font-mono ${positions[0].unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                ${positions[0].unrealized_pnl.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
        {decisions.length === 0 ? (
          <div className="text-center py-8 text-xs text-slate-500">
            No AI decisions recorded yet. Start training to see decisions.
          </div>
        ) : (
          decisions.slice(0, 15).map((d) => (
            <div
              key={d.timestamp}
              className="flex items-center justify-between gap-2 p-1.5 rounded border border-slate-800/50 bg-slate-900/40"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    ACTION_LABEL_COLORS[d.action]
                  } ${ACTION_LABEL_BORDER[d.action]}`}
                >
                  {d.action}
                </span>
                <span className="text-xs text-slate-400 truncate">
                  {new Date(d.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex items-center gap-3 text-[10px]">
                <span className={`font-mono ${
                  d.net_roi >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}>
                  {d.net_roi.toFixed(2)}%
                </span>
                <span className={`font-mono ${
                  d.q_value >= 0 ? 'text-sky-400' : 'text-slate-400'
                }`}>Q:{d.q_value.toFixed(2)}</span>
                <span className={`font-mono ${
                  d.done ? 'text-amber-400' : 'text-slate-500'
                }`}>{d.done ? 'DONE' : 'LIVE'}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AiMetricsPanel({
  metrics,
  status,
}: {
  metrics: AiMetrics | null;
  status: AiStatus | null;
}) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-[#0B1120] p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-300 mb-4">AI Performance Metrics</h3>
      <div className="space-y-3">
        <MetricRow label="Total Trades" value={metrics?.total_trades ?? 0} />
        <MetricRow label="Winning Trades" value={metrics?.winning_trades ?? 0} good />
        <MetricRow label="Losing Trades" value={metrics?.losing_trades ?? 0} />
        <MetricRow label="Win Rate" value={`${metrics?.win_rate?.toFixed(1) ?? 0}%`} good={(metrics?.win_rate ?? 0) >= 55} />
        <MetricRow label="Total PnL" value={`$${metrics?.total_pnl?.toFixed(2) ?? '0.00'}`} good={(metrics?.total_pnl ?? 0) >= 0} />
        <MetricRow label="Max Drawdown" value={`${metrics?.max_drawdown_pct?.toFixed(2) ?? 0}%`} />
        <MetricRow label="Daily Target (10%)" value={metrics?.daily_target_achieved ? 'ACHIEVED' : 'PENDING'} good={metrics?.daily_target_achieved ?? false} />
      </div>

      <div className="mt-5 p-3 rounded-lg border border-slate-700/50 bg-slate-800/40">
        <h4 className="text-xs font-semibold text-slate-400 mb-2">System Status</h4>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-400">AI Engine</span>
            <span className={`font-mono ${status?.ai_running ? 'text-emerald-400' : 'text-rose-400'}`}>
              {status?.ai_running ? 'RUNNING' : 'OFFLINE'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Models</span>
            <span className={`font-mono ${status?.models_loaded ? 'text-emerald-400' : 'text-rose-400'}`}>
              {status?.models_loaded ? 'LOADED' : 'NOT LOADED'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Database</span>
            <span className={`font-mono ${status?.database_exists ? 'text-emerald-400' : 'text-rose-400'}`}>
              {status?.database_exists ? 'CONNECTED' : 'MISSING'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Version</span>
            <span className="font-mono text-slate-300">{status?.version ?? 'n/a'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  good,
}: {
  label: string;
  value: string | number;
  good?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-800/50 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <span
        className={`text-xs font-mono font-bold ${
          good ? 'text-emerald-400' : 'text-slate-200'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function ATradeLog({ trades }: { trades: Trade[] }) {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-[#0B1120] p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-300">Trade History</h3>
        <span className="text-[10px] font-mono text-slate-500">{trades.length} trades</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-slate-800/50">
              <th className="text-left pb-1 text-slate-400 font-semibold uppercase tracking-wider">Time</th>
              <th className="text-left pb-1 text-slate-400 font-semibold uppercase tracking-wider">Side</th>
              <th className="text-right pb-1 text-slate-400 font-semibold uppercase tracking-wider">Price</th>
              <th className="text-right pb-1 text-slate-400 font-semibold uppercase tracking-wider">PnL</th>
              <th className="text-left pb-1 text-slate-400 font-semibold uppercase tracking-wider">Strategy</th>
              <th className="text-left pb-1 text-slate-400 font-semibold uppercase tracking-wider">ML/DL/RL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {trades.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-xs text-slate-500">
                  No trades yet. Train the AI to see trade history.
                </td>
              </tr>
            ) : (
              trades.map((t) => (
                <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-1 text-slate-300 font-mono">
                    {new Date(t.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-1">
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold ${
                        t.side.includes('LONG') || t.side.includes('BUY')
                          ? 'bg-emerald-900/20 border border-emerald-500/30 text-emerald-400'
                          : 'bg-rose-900/20 border border-rose-500/30 text-rose-400'
                      }`}
                    >
                      {t.side.includes('LONG') || t.side.includes('BUY') ? 'LONG' : 'SHORT'}
                    </span>
                  </td>
                  <td className="py-1 text-right text-slate-200 font-mono">
                    ${t.entry_price.toFixed(2)}
                  </td>
                  <td className="py-1 text-right font-mono">
                    <span
                      className={`${
                        t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                    </span>
                  </td>
                  <td className="py-1 text-slate-400 truncate max-w-[80px]">
                    {t.strategy ?? 'RL Ensemble'}
                  </td>
                  <td className="py-1 text-slate-500 font-mono">
                    {`${t.ml_confidence?.toFixed(2) ?? '0.00'} / ${t.dl_confidence?.toFixed(2) ?? '0.00'} / ${t.rl_confidence?.toFixed(2) ?? '0.00'}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
