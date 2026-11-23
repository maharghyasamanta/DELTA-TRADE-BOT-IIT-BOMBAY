interface PhaseRoadmapStripProps {
  firebaseConfigured?: boolean;
  isSignedIn?: boolean;
  geminiConfigured?: boolean | null;
  geminiVerified?: boolean;
}

export function PhaseRoadmapStrip({
  firebaseConfigured = false,
  isSignedIn = false,
  geminiConfigured = null,
  geminiVerified = false,
}: PhaseRoadmapStripProps) {
  const phase3Status =
    firebaseConfigured && isSignedIn
      ? 'Ready'
      : 'Setup Pending';
  const phase4Status =
    geminiConfigured === null
      ? 'Checking'
      : geminiConfigured && geminiVerified
        ? 'Active'
        : 'Setup Pending';

  const phases = [
    {
      phase: 'Phase 1',
      title: 'Delta Proxy, Picker, Live Ticker & Candle Chart',
      status: 'Active',
      detail: 'Verified live: Delta REST proxy, SSE WebSocket stream, ticker & candle chart',
    },
    {
      phase: 'Phase 2',
      title: 'Regime Engine & Chart Markers',
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
      detail:
        geminiConfigured === null
          ? 'Checking server-side Gemini configuration...'
          : geminiConfigured === false
            ? 'Blocked: GEMINI_API_KEY not set in server environment'
            : geminiVerified
              ? 'Verified live end to end with deterministic number-grounding guard'
              : 'Configured (gemini-3.8-flash / gemini-3.5-flash-lite); click "Explain these numbers" to verify live (may see temporary 503 spikes)',
    },
    {
      phase: 'Phase 5',
      title: 'Detector Evaluation Panel',
      status: 'Planned',
      detail: 'Not built yet: historical spike lead-time & false-alarm audit',
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
          · Phase 4 {geminiVerified ? 'active' : 'setup pending'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {phases.map((item) => {
          const isActive = item.status === 'Active';
          const isReady = item.status === 'Ready';
          const isPending = item.status === 'Setup Pending';
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
