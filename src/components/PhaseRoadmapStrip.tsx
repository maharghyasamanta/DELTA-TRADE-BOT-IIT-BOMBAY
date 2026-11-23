import type { ExplainStatusResponse } from '../contracts/explain';

interface PhaseRoadmapStripProps {
  firebaseConfigured?: boolean;
  isSignedIn?: boolean;
  geminiConfigured?: boolean | null;
  geminiVerified?: boolean;
  explainStatus?: ExplainStatusResponse | null;
  phase5Completed?: boolean;
  phase5Error?: string | null;
  phase5Detail?: string | null;
}

export function PhaseRoadmapStrip({
  firebaseConfigured = false,
  isSignedIn = false,
  geminiConfigured = null,
  geminiVerified = false,
  explainStatus = null,
  phase5Completed = false,
  phase5Error = null,
  phase5Detail = null,
}: PhaseRoadmapStripProps) {
  const phase3Status =
    firebaseConfigured && isSignedIn
      ? 'Ready'
      : 'Setup Pending';

  const bothModelsMissing =
    geminiConfigured === true &&
    explainStatus?.primaryModelOk === false &&
    explainStatus?.fallbackModelOk === false;

  const phase4Status =
    geminiConfigured === null
      ? 'Checking'
      : bothModelsMissing
        ? 'Model Not Found'
        : geminiConfigured && geminiVerified
          ? 'Active'
          : 'Setup Pending';

  const phase4Detail = (() => {
    if (geminiConfigured === null) {
      return 'Checking server-side Gemini configuration...';
    }
    if (geminiConfigured === false) {
      return 'Blocked: GEMINI_API_KEY not set in server environment';
    }
    if (bothModelsMissing) {
      return `Model not found: ${explainStatus?.modelCheckError ?? `${explainStatus?.primaryModel ?? 'primary'} / ${explainStatus?.fallbackModel ?? 'fallback'} unavailable`}`;
    }
    if (geminiVerified) {
      return `Verified live (${explainStatus?.primaryModel ?? 'gemini-4-hydrogen'}) with deterministic number-grounding guard`;
    }
    const primaryLabel = explainStatus?.primaryModel ?? 'gemini-4-hydrogen';
    const fallbackLabel = explainStatus?.fallbackModel ?? 'gemini-3.1-flash-lite';
    const modelNote =
      explainStatus?.primaryModelOk === false
        ? `primary "${primaryLabel}" not found, fallback "${fallbackLabel}" available`
        : `${primaryLabel} / ${fallbackLabel}`;
    return `Configured (${modelNote}); click "Explain these numbers" to verify live`;
  })();

  const phase5Status = phase5Completed ? 'Active' : 'Setup Pending';
  const phase5ResolvedDetail = phase5Completed
    ? (phase5Detail ?? 'Verified live: historical spike lead-time & false-alarm audit completed')
    : phase5Error
      ? `Blocked: ${phase5Error}`
      : 'Click "Run evaluation" in Phase 5 above to run the audit on live historical candles';

  const phases = [
    {
      phase: 'Phase 1',
      title: 'Delta Proxy, Picker, Live Ticker & Candle Chart',
      status: 'Active',
      detail: 'Verified live: Delta REST proxy, SSE WebSocket stream, ticker & candle chart',
    },
    {
      phase: 'Phase 2',
      title: 'Bot Signal Engine & Chart Markers',
      status: 'Active',
      detail: 'Verified live: vol z-score, trend strength, CUSUM markers & 0–100 score',
    },
    {
      phase: 'Phase 3',
      title: 'Guardrail Rules & Firestore Decision Log',
      status: phase3Status,
      detail: !firebaseConfigured
        ? 'Guardrail rules live; Firestore log blocked: missing Firebase config'
        : isSignedIn
          ? 'Guardrail rules live & Google Sign-In active; log/list/delete ready for live test'
          : 'Guardrails live in UI; sign in with Google to verify Firestore decision log live',
    },
    {
      phase: 'Phase 4',
      title: 'Gemini Structured Explanations',
      status: phase4Status,
      detail: phase4Detail,
    },
    {
      phase: 'Phase 5',
      title: 'Detector Evaluation Panel',
      status: phase5Status,
      detail: phase5ResolvedDetail,
    },
  ] as const;

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
          Phases 1–2 active · Phase 3{' '}
          {firebaseConfigured
            ? isSignedIn
              ? 'signed in (ready for Firestore test)'
              : 'awaiting sign-in for Firestore test'
            : 'setup pending (missing Firebase config)'}{' '}
          · Phase 4 {geminiVerified ? 'active' : bothModelsMissing ? 'model not found' : 'setup pending'} · Phase 5{' '}
          {phase5Completed ? 'active' : 'setup pending'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {phases.map((item) => {
          const isActive = item.status === 'Active';
          const isReady = item.status === 'Ready';
          const isPending = item.status === 'Setup Pending';
          const isError = item.status === 'Model Not Found';
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
                      : isReady
                        ? 'font-medium text-sky-300'
                        : isError
                          ? 'font-medium text-rose-400'
                          : isPending
                            ? 'font-medium text-amber-300'
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
