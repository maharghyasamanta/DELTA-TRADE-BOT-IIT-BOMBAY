const PHASES = [
  {
    phase: 'Phase 1',
    title: 'Delta Proxy, Picker, Live Ticker & Candle Chart',
    status: 'Active',
    detail: 'Live REST proxy + server WebSocket SSE stream + Lightweight Charts',
  },
  {
    phase: 'Phase 2',
    title: 'Regime Engine & Chart Markers',
    status: 'Next',
    detail: 'Vol z-score, trend strength, CUSUM change-point, 0–100 score',
  },
  {
    phase: 'Phase 3',
    title: 'Guardrail Rules & Firestore Decision Log',
    status: 'Planned',
    detail: 'Deterministic CONTINUE / REDUCE SIZE / PAUSE + Google Sign-In log',
  },
  {
    phase: 'Phase 4',
    title: 'Gemini Structured Explanations',
    status: 'Planned',
    detail: 'Server-side JSON explanations grounded strictly in computed metrics',
  },
  {
    phase: 'Phase 5',
    title: 'Detector Evaluation Panel',
    status: 'Planned',
    detail: 'Historical spike lead-time & false-alarm audit on real candles',
  },
] as const;

export function PhaseRoadmapStrip() {
  return (
    <section
      id="roadmap"
      aria-label="Phased Delivery Roadmap"
      className="rounded-lg border border-slate-800/90 bg-[#111A2E] px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/70 pb-3">
        <h2 className="font-display text-sm font-semibold text-slate-100">
          Build Delivery Phases
        </h2>
        <span className="text-[11px] text-slate-400">
          Phase 1 live for market-data testing before Phase 2 regime indicators
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {PHASES.map((item) => {
          const isActive = item.status === 'Active';
          return (
            <div
              key={item.phase}
              className="border-t border-slate-800/70 pt-2.5 sm:border-t-0 sm:border-l sm:border-slate-800/70 sm:pl-3 sm:pt-0 first:border-l-0 first:pl-0"
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono font-semibold text-slate-300">{item.phase}</span>
                <span
                  className={
                    isActive
                      ? 'font-medium text-emerald-400'
                      : 'text-slate-500'
                  }
                >
                  {item.status}
                </span>
              </div>
              <div className="mt-1 text-xs font-medium text-slate-200">{item.title}</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                {item.detail}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
