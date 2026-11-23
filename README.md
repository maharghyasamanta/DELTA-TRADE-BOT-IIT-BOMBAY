# Regime Sentinel

Read-only market-regime monitor and historical detector evaluation dashboard built with React 19, Vite, Express, Firebase Auth/Firestore, and Gemini structured output.

> **Advisory Only**: This application never places, routes, or simulates orders, and its deterministic guardrails and Gemini explanations never recommend trading actions.

## Features

- **Phase 1 — Live Market Data Proxies**:
  - **Delta Exchange India** (`api.india.delta.exchange` REST + `wss://socket.india.delta.exchange` bridged via SSE `/api/delta/stream`).
  - **Alpaca Market Data** (`data.alpaca.markets` REST `/api/alpaca/ping`, `/bars`, `/quote/:symbol`, `/trade/:symbol`, `/validate/:symbol` defaulting to `iex` feed).
- **Phase 2 — Pure Regime Engine (`src/engine/regime.ts`)**:
  - Rolling Volatility Z-Score, OLS Trend Strength ($R^2 \times \text{sign}(\beta)$), two-sided CUSUM structural change-points, and composite 0–100 Regime Intensity Score.
  - Causal bar-gap detection (`dt > 1.5 * median`) prevents overnight/weekend price jumps from triggering spurious CUSUM spikes.
- **Phase 3 — Guardrail Rules & Firestore Decision Log**:
  - Deterministic `CONTINUE` / `REDUCE_SIZE` / `PAUSE` / `NO_DECISION` evaluation.
  - Private per-user decision persistence in Firestore under `users/{uid}/decisions/{docId}` on the configured named database (`ai-studio-deltatradebotiit-add43f67-32e1-4764-933a-51ce2781a444` or `(default)`).
- **Phase 4 — Gemini Structured Explanation (`server/geminiClient.ts` + `src/engine/explainGuard.ts`)**:
  - Server-side proxy using `@google/genai` (`gemini-4-hydrogen` primary, `gemini-3.1-flash-lite` fallback, overridable via env vars).
  - Enforces strict deterministic number grounding (`UNGROUNDED_OUTPUT`) and banned advisory word filtering (`DISALLOWED_CONTENT`) with one corrective retry + fallback before blocking.
- **Phase 5 — Causal Detector Evaluation (`src/engine/evaluation.ts`)**:
  - Evaluates historical recall, episode precision, Wilson 95% intervals (optimistic under temporal autocorrelation), lead times, and circular-shift chance baselines with zero lookahead.

## Environment Variables & Secrets

All API keys are server-side only (store them in the platform **Secrets** panel or a gitignored `.env` file; never commit values or expose them to the browser):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Phase 4 | — | Server-side key for `@google/genai` |
| `GEMINI_MODEL` | Optional | `gemini-4-hydrogen` | Primary Gemini model override |
| `GEMINI_FALLBACK_MODEL` | Optional | `gemini-3.1-flash-lite` | Fallback Gemini model override |
| `ALPACA_API_KEY_ID` | Alpaca view | — | Server-side Alpaca Market Data key ID |
| `ALPACA_API_SECRET_KEY` | Alpaca view | — | Server-side Alpaca Market Data secret |
| `TRUST_PROXY` | Optional | `1` | Express `trust proxy` hops (`1`, `true`, `false`) |

## Scripts

```bash
npm run dev       # Start Express + Vite dev server on port 3000
npm run lint      # TypeScript typecheck (tsc --noEmit)
npx tsx --test tests/*.test.ts  # Run pure unit tests
npm run build     # Build client (dist/) + bundle server (server.js)
npm start         # Run production server (node server.js)
```

## Firestore Security Rules Verification Checklist

Before marking Phase 3 production-ready after editing `firestore.rules`:

1. **Named Database Match**: Confirm `firebase-applet-config.json` points `firestoreDatabaseId` to the intended Firestore database (`ai-studio-deltatradebotiit-add43f67-32e1-4764-933a-51ce2781a444`) and deploy rules to that exact database.
2. **Valid Create Succeeds**: Verified signed-in owner (`request.auth.uid == uid`, `email_verified == true`) creating `users/{uid}/decisions/{validId}` with `timestamp: serverTimestamp()` and all required schema keys succeeds.
3. **Server Timestamp Enforced**: Create with client-supplied literal timestamp or missing `timestamp` fails (`data.timestamp == request.time`).
4. **Extra/Unknown Keys Rejected**: Create adding an unexpected top-level, `inputs`, or `thresholdsUsed` field fails (`hasOnly` check).
5. **All List Elements Bounded**: `firedRules` (1–16 items, each non-empty string ≤ 64 chars) and `reasons` (1–16 items, each non-empty string ≤ 300 chars) reject invalid elements at any index `0..15`, not just index `0`.
6. **Owner-Only Read & Delete**: Unauthenticated or cross-user (`auth.uid != uid`) `get`, `list`, and `delete` fail; owner `get`, `list`, and `delete` succeed.
7. **Updates & Arbitrary Collections Denied**: `update` on `decisions` and any read/write outside `users/{uid}/decisions/{docId}` are explicitly denied.