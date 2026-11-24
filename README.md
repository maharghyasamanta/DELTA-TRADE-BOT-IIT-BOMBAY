# Delta Trade Bot

Market telemetry, causal signal engine, historical detector evaluation, and **SIMULATED** server-side paper trading dashboard built with React 19, Vite, Express, Firebase Auth/Firestore, and Gemini structured output.

> **Safety & Simulation Boundary**: Market data feeds are read-only public endpoints (`api.india.delta.exchange` and `data.alpaca.markets`). All Paper Trading orders, fills, margin, liquidations, and funding settlements execute strictly inside our server (`server/paper/`) using virtual balances. Zero real-money exchange API keys or order submission paths exist anywhere in the codebase.

## Features

- **Phase 1 — Live Market Data Proxies**:
  - **Delta Exchange India** (`api.india.delta.exchange` REST + `wss://socket.india.delta.exchange` bridged via SSE `/api/delta/stream`).
  - **Alpaca Market Data** (`data.alpaca.markets` REST `/api/alpaca/ping`, `/bars`, `/quote/:symbol`, `/trade/:symbol`, `/validate/:symbol` defaulting to `iex` feed).
- **Phase 2 — Pure Bot Signal Engine (`src/engine/regime.ts`)**:
  - Rolling Volatility Z-Score, OLS Trend Strength ($R^2 \times \text{sign}(\beta)$), two-sided CUSUM structural change-points, and composite 0–100 Bot Signal Intensity Score.
  - Causal bar-gap detection (`dt > 1.5 * median`) prevents overnight/weekend price jumps from triggering spurious CUSUM spikes.
- **Phase 3 — Guardrail Rules & Firestore Decision Log**:
  - Deterministic `CONTINUE` / `REDUCE_SIZE` / `PAUSE` / `NO_DECISION` evaluation.
  - Private per-user decision persistence in Firestore under `users/{uid}/decisions/{docId}` on the configured named database (`ai-studio-deltatradebotiit-add43f67-32e1-4764-933a-51ce2781a444` or `(default)`).
- **Phase 4 — Gemini Structured Explanation (`server/geminiClient.ts` + `src/engine/explainGuard.ts`)**:
  - Server-side proxy using `@google/genai` (`gemini-3.8-flash` primary, `gemini-3.5-flash-lite` fallback, overridable via env vars).
  - Enforces strict deterministic number grounding (`UNGROUNDED_OUTPUT`) and banned advisory word filtering (`DISALLOWED_CONTENT`) with one corrective retry + fallback on 404/400/429/5xx/timeout before blocking.
- **Phase 5 — Causal Detector Evaluation (`src/engine/evaluation.ts`)**:
  - Evaluates historical recall, episode precision, Wilson 95% intervals (`assumes independent trials, likely too narrow` under temporal autocorrelation), lead times, and circular-shift chance baselines with zero lookahead.
- **Paper Trading Workspace (`server/paper/` + `src/engine/paperBrokerEngine.ts`)**:
  - **Exact Fixed-Point Math**: Zero-dependency BigInt `10^8` units and integer ticks (`src/engine/decimal.ts`).
  - **Reconnect Replay & 7-Day Stale Cap**: Restores saved user snapshots from Firestore (`users/{uid}/paper/ledger/*`), rejects stale `sessionVersion` overwrites with HTTP `409`, replays missed closed bars + `MARK:` candles chronologically (applying stop-loss gap-open slippage, scaled maintenance-margin liquidation, funding at `rateExchangeInterval`), and halts sessions offline > 7 days as `stale: true`.
  - **Quota-Conscious Firestore Persistence (`src/services/paperPersistence.ts`)**: Never writes per-tick `mark_price` updates; writes `accounts`/`positions`/`orders` only on lifecycle events (`forceEventWrite: true`) or at most every 60s, and creates immutable `fills`/`trades`/`versions`/`heldOutLogs` once with idempotent `already-exists` handling.
  - **3-Split Walk-Forward Worker (`server/paper/walkForwardWorker.ts`)**: Runs parameter grid search off the main thread (`worker_threads`) across 50% In-Sample / 25% Out-of-Sample, keeping the final 25% Held-Out untouched and logging every held-out inspection with persistent bias warnings.

## Environment Variables & Secrets

All API keys are server-side only (store them in the platform **Secrets** panel or a gitignored `.env` file; never commit values or expose them to the browser):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Phase 4 | — | Server-side key for `@google/genai` |
| `GEMINI_MODEL` | Optional | `gemini-3.8-flash` | Primary Gemini model override |
| `GEMINI_FALLBACK_MODEL` | Optional | `gemini-3.5-flash-lite` | Fallback Gemini model override |
| `ALPACA_API_KEY_ID` | Alpaca view | — | Server-side Alpaca Market Data key ID |
| `ALPACA_API_SECRET_KEY` | Alpaca view | — | Server-side Alpaca Market Data secret |
| `TRUST_PROXY` | Optional | `0` | Express `trust proxy` hops (`0`, `1`, `true`, `false`) |

## Scripts

```bash
npm run dev       # Start Express + Vite dev server on port 3000
npm run lint      # TypeScript typecheck (tsc --noEmit)
npx tsx --test tests/*.test.ts  # Run pure unit tests
npm run build     # Build client (dist/) + bundle server (server.js)
npm start         # Run production server (node server.js)
```

## Firestore Security Rules Verification Checklist

Before marking Firestore deployment production-ready after editing `firestore.rules`:

1. **Named Database Match**: Confirm `firebase-applet-config.json` points `firestoreDatabaseId` to the intended Firestore database (`ai-studio-deltatradebotiit-add43f67-32e1-4764-933a-51ce2781a444`) and deploy rules to that exact database.
2. **Owner-Only Verified Access**: All reads/writes under `users/{uid}/decisions/*` and `users/{uid}/paper/ledger/*` require `request.auth != null && request.auth.uid == uid && request.auth.token.email_verified == true`.
3. **Server Timestamp Enforced**: Decision logs require `timestamp == request.time`; all paper ledger collections require `serverWrittenAt == request.time`.
4. **Immutable Ledgers & Exact Key Sets (`hasOnly`)**: `fills`, `trades`, `versions`, and `heldOutLogs` deny updates/deletes and enforce exact schema keys via `data.keys().hasOnly([...])` plus positive integer tick/version validation.
5. **Global Default Deny**: Any path outside the explicit user-owned collections is denied by default.