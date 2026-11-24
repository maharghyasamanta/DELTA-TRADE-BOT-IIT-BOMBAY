# Delta Trade Bot — Paper Trading Simulator & Walk-Forward Tuning

Adds a server-side **Paper Trading** simulation engine with pessimistic market/limit/stop fills, mark-price margin & liquidation accounting modeled on Delta Exchange India rules, string-serialized `BigInt` arithmetic with explicit directional rounding, authenticated reconnect replay, worker-thread walk-forward tuning, and quota-conscious owner-locked Firestore persistence (`users/{uid}/paper/...`). All trading remains strictly simulated inside our own server with zero real-money API keys or exchange order paths.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **All Phase 1 choices, first-round amendments, and second-round revisions are incorporated below for final approval:**

- **Strict JWT Auth & Session Cap (Zero Admin SDK)**: No unauthenticated paper sessions. Every paper API route verifies the caller's Firebase ID token locally via Node `crypto` RS256 against Google's cached X.509 keys (with Web API key `accounts:lookup` fallback), validating `iss`, `aud`, `exp`, non-empty `sub`, and `email_verified === true`, and enforcing at most 5 active/saved sessions per user.
- **Quota-Safe Client Firestore Persistence (`users/{uid}/paper/...`)**: Do **not** write per-tick `mark_price` updates to Firestore. Persist strictly on discrete lifecycle events (orders, fills, position open/close/liquidation, funding settlement, kill switch, parameter versions, held-out evaluations) plus a throttled account/position snapshot at most once every **60 seconds**. Immutable ledger entries (`fills`, `trades`, `versions`, `heldOutLogs`) use deterministic IDs (`fillId`, `tradeId`), treat `"already-exists"` as success, enforce `allow update: if false; allow delete: if false;`, and keep Firestore validation helpers shallow.
- **Restore Replay with Strategy, `MARK:` Candles & 7-Day Stale Cap**: On reconnect, the client sends its latest Firestore snapshot; the server validates it with hand-written validators and replays up to **7 days** of missed history—evaluating both the persisted parameter version's strategy on closed candles (executing at next bar open) and `MARK:` candles for liquidation/funding (`rate_exchange_interval` read from Delta's `/v2/products` metadata). All fills produced during catch-up are tagged `replayed: true`. If elapsed downtime exceeds 7 days, the session is marked **stale** and halted until reset.
- **Exact String `BigInt` Money & Asymmetric Rounding**: Zero-dependency `BigInt` fixed-point math (`10^8` scale) and integer ticks serialized strictly as decimal strings in JSON and Firestore, with explicit rounding helpers: **fees, slippage costs, and margin requirements always round UP**, while **proceeds and payouts round DOWN**. Exchange fees, funding, and margin rates are parsed directly from strings.
- **Worker-Thread Walk-Forward Search & Audit Trail**: Offloads focused 3-split walk-forward searches (with live-consistent configurable fixed half-spread) to a Node `worker_thread`, limited to **1 active search per `uid`** and a capped grid size, logging every held-out inspection and warning after the first look.
- **Configurable Daily-Loss Reset Time Zone**: Daily PnL halt boundaries reset at midnight in a user-configured valid IANA time zone (default `'UTC'`), evaluated strictly against exchange timestamps.

---

## 1. Overview & Core Concept

- **What It Does**: Lets signed-in operators run virtual USDT paper sessions (`10,000 USDT` default) on Delta Exchange India perpetuals using live bid/ask quotes, `mark_price`, `funding_rate`, exchange-provided `rate_exchange_interval`, `tick_size`, `contract_value`, maker/taker commission rates, and scaled maintenance margin rules; evaluate deterministic guardrails; run manual test orders or the baseline trend-following strategy; audit statistical edge and backtest drift; and tune parameters cleanly with zero real-money risk.
- **Target Audience & Context**: Systematic derivatives operators validating bot behavior, execution drag, and risk guardrails against real exchange structure.
- **Key Value**: Pairs pessimistic execution mechanics (spread crossing, size-scaled tick slippage, gap-open stop slippage, mark-price liquidations, directional rounding) with quota-safe replay persistence and honest out-of-sample statistics.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Authenticated Workspace & Persistent Paper Warning**: Signed-in users open `"Paper Trading"` from the Top Bar navigation (signed-out visitors see a sign-in prompt). Every screen inside the workspace carries a high-contrast `"PAPER — SIMULATED FUNDS"` banner.
  2. **Session Configuration & Reconnect Catch-Up**: Users configure virtual capital (`10,000 USDT`), max leverage (`5x` default, capped by `default_leverage`), risk limits (`1%` max risk per trade, max open positions, max daily loss, max drawdown), and daily-loss reset time zone (e.g., `UTC`, `Asia/Kolkata`). Reconnecting runs the restore handshake—automatically catching up missed strategy bars, stops, `MARK:` liquidations, and funding up to 7 days (tagging fills `replayed: true`) or surfacing an explicit `"Session Stale (>7d offline) — Reset Required"` state.
  3. **Live Trading Desk, Order Ticket & Kill Switch**: Displays mark-to-market KPIs (Balance, Equity at `mark_price`, Unrealized PnL, Margin Used, Drawdown, Daily Reset TZ/Countdown), a `lightweight-charts` Equity Curve, Open Positions (liquidation price, accrued funding, live PnL), Open Orders, and a Manual Order Ticket (Market/Limit, SL/TP, idempotent `clientOrderId`). `"Kill Switch: Flatten & Halt"` immediately simulates market exits across all open positions and halts strategy ticks.
  4. **Journal, Analytics, Worker Tuner & Gemini Trade Review**: Closed trades show fees, slippage, funding, net PnL, `replayed` status, and entry/exit guardrail + signal snapshots, with one-click `"Explain closed trade"` Gemini summaries. Analytics report win rate (`wilsonInterval95`), profit factor, expectancy, and guardrail/score-bucket PnL splits (`"Insufficient sample"` below 30 trades). Walk-forward runs dispatch to a background worker (1 active job per user, capped grid, progress/busy indicator), displaying separate In-Sample / Out-of-Sample / Held-Out results, drift comparisons, and a persistent bias warning after held-out evaluation #1.

- **Visual Identity & Theme**:
  - **Aesthetic Direction**: High-contrast dark quantitative desk (`#0B1120` canvas / `#111A2E` single-elevation panels, `1px` `border-slate-800` hairlines, zero nested rounded boxes or thick left accent bars).
  - **Typography & Tabular Discipline**: Uses existing `Plus Jakarta Sans`, `DM Sans`, and `JetBrains Mono` (`tabular-nums`) across all string-backed `BigInt` prices, balances, fees, confidence intervals, and `36px–44px` compact table rows.
  - **Color & Metadata Restraint**: Semantic accents (`#38BDF8` sky primary, `#10B981` nominal/positive, `#F59E0B` `PAPER — SIMULATED FUNDS` & bias/sample warnings, `#F43F5E` loss/liquidation/kill switch) always paired with text labels or icons, and clean unboxed `·`-separated metadata.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1 — Pessimistic Fills, Asymmetric Rounding & Mark-Price Margin**
  - *Chosen Approach*: Market orders cross `best_ask`/`best_bid` + size-scaled tick slippage; limits fill only on strict price cross; stops fill at `stop_price ± slippage` or `bar_open ± slippage` on open gaps (stop before target inside one bar); `BigInt` rounding helpers always round costs/fees UP and proceeds DOWN; equity, margin, funding (`rate_exchange_interval` from API), and Delta-scaled maintenance margin liquidation checks run on `mark_price` (and `MARK:` historical candles during replay).
  - *Why*: Eliminates floating-point drift, rounding leakage, last-trade wick illusions, and optimistic fill assumptions.
  - *Alternatives Considered*: Symmetric nearest rounding or trade-candle liquidation checks; rejected because they understate liquidation and cumulative fee drag.

- **Decision 2 — Quota-Conscious Firestore Writes + Strategy-Complete Replay**
  - *Chosen Approach*: Suppress per-tick `mark_price` database writes; flush Firestore on trade/order/fill/funding/version events and at most every 60 seconds for account/position snapshots. Use deterministic document IDs (`fillId`, `tradeId`, `clientOrderId`) treating `"already-exists"` as idempotent success. On reconnect, replay up to 7 days of missed closed candles + `MARK:` bars through both broker stops/funding and the session's persisted baseline strategy, tagging resulting fills `replayed: true`, and marking `>7d` sessions `stale`.
  - *Why*: Protects Starter Tier free daily write limits while preserving accurate unattended position/strategy state across restarts without unbounded catch-up latency.
  - *Alternatives Considered*: High-frequency tick writes or position-only replay without strategy ticks; rejected for quota exhaustion and strategy state divergence.

- **Decision 3 — Worker-Thread Bounded Walk-Forward Search**
  - *Chosen Approach*: Execute focused 3-split walk-forward grid search inside a dedicated Node `worker_thread` using configurable fixed half-spread parity, capped parameter combinations, and a strict per-`uid` concurrency lock (`1` running search per user). Every held-out evaluation is persisted to `heldOutLogs` and warns after inspection #1.
  - *Why*: Keeps the Express API event loop responsive for live SSE streams and order requests during multi-year/thousands-of-bars grid evaluations.
  - *Alternatives Considered*: In-process synchronous search on the Express main thread; rejected because CPU-bound loops block concurrent ticker/candle requests.

- **Decision 4 — Shallow, Immutable Ledger Security Rules & Zero-Admin Auth**
  - *Chosen Approach*: Verify Firebase ID tokens purely via cached Google public keys (`iss`, `aud`, `exp`, `sub`, `email_verified === true`) with `accounts:lookup` fallback and hand-written JSON validators. Keep `firestore.rules` checks shallow (required/allowed keys, scalar bounds, `request.time`) and set `allow update: if false; allow delete: if false;` on `fills`, `trades`, `versions`, and `heldOutLogs`.
  - *Why*: Satisfies Starter Tier constraints cleanly, blocks forged/unverified tokens and client ledger tampering, and avoids rule-complexity limits.
  - *Alternatives Considered*: Deep recursive list/nested-map rule expressions or allowing user deletion of past fills; rejected for rule complexity and audit-trail integrity.

---

## 4. Technical Architecture & Data Strategy

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                SIGNED-IN BROWSER CLIENT (React 19 + Firebase Auth)           │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │  Paper Trading Tab (Auth Required · "PAPER — SIMULATED FUNDS" Banner)  │  │
│  │  1. Reconnect -> send Firestore snapshot (max 7d replay or Stale flag) │  │
│  │  2. Event-driven + 60s throttled Firestore sync (ID-keyed idempotency) │  │
│  │  3. Render KPIs, Chart, Order Ticket, Journal, Worker Tuner, AI Audit  │  │
│  └───────────────────────────┬──────────────────────────┬─────────────────┘  │
└──────────────────────────────┼──────────────────────────┼────────────────────┘
                               │ Bearer ID Token          │ Web SDK (Event + 60s
                               ▼                          │ Throttle; ignore dupes)
┌─────────────────────────────────────────────┐           ▼
│        EXPRESS SERVER (Node / ESM)          │  ┌─────────────────────────────┐
│  ┌───────────────────────────────────────┐  │  │   CLOUD FIRESTORE           │
│  │ Zero-Admin-SDK JWT Verifier           │  │  │   users/{uid}/paper/        │
│  │ (iss, aud, exp, sub, email_verified)  │  │  │   (Shallow rules; no        │
│  └───────────────────┬───────────────────┘  │  │    update/delete on ledger) │
│                      ▼                      │  │   ├─ accounts/{sessionId}   │
│  ┌───────────────────────────────────────┐  │  │   ├─ orders/{clientOrderId} │
│  │ Paper Broker & Replay Engine          │  │  │   ├─ fills/{fillId} (fixed) │
│  │ (Max 5/uid · Hand Validators · Configurable TZ) │   ├─ positions/{posId}      │
│  │ • String BigInt 1e-8 + Up/Down Round  │  │  │   ├─ trades/{tradeId}(fixed)│
│  │ • Strategy + MARK: Liquidation Replay │  │  │   ├─ versions/{versionId}   │
│  │ • Tagged replayed:true + API Funding  │  │  │   └─ heldOutLogs/{logId}    │
│  └───────────┬───────────────┬───────────┘  │  └─────────────────────────────┘
│              │               │              │
│              ▼               ▼              │
│  ┌─────────────────┐ ┌───────────────────┐  │
│  │ Delta Read-Only │ │ Worker Thread     │  │
│  │ Market Proxies  │ │ 3-Split Tuner     │  │
│  │ (quotes, MARK:, │ │ (1/uid, Cap Grid, │  │
│  │  rate_exchange) │ │  Fixed HalfSpread)│  │
│  └─────────────────┘ └─────────┬─────────┘  │
│                                ▼            │
│                      ┌───────────────────┐  │
│                      │ Gemini Trade      │  │
│                      │ Review Guard      │  │
│                      └───────────────────┘  │
└─────────────────────────────────────────────┘
```

- **Data Model & Fixed-Point State**:
  - **String-Encoded Fixed-Point Quantities & Asymmetric Rounding**: All `BigInt` micro-units (`10^8` scale) serialize as decimal strings across HTTP and Firestore (`balanceUnits`, `equityUnits`, `realizedPnlUnits`, `unrealizedPnlUnits`, `marginUsedUnits`, `feeUnits`, `fundingUnits`, `liquidationPenaltyUnits`, `contractValueUnits`), paired with integer tick levels (`priceTicks`, `tickSizeUnits`). Explicit directional rounding utilities force costs/fees/margin requirements UP and payouts/proceeds DOWN.
  - **Firestore Subcollections (`users/{uid}/paper/...`) & Quota Policy**:
    - `accounts/{sessionId}`: Account state, string balances/PnL, `resetTimeZone` (IANA string, default `'UTC'`), `lastProcessedCandleTime`, `lastFundingTime`, `stale` flag, halt flags, `parameterVersionId`, `heldOutInspectionCount`, `serverUpdatedAt`. Written only on events + 60s throttle (never per tick).
    - `orders/{clientOrderId}`: Client key as doc ID; order specs, guardrail state, status, exchange timestamp.
    - `fills/{fillId}`: Immutable (`allow update, delete: if false`), doc ID = `fillId`, includes `replayed: boolean`, fee string, slippage ticks, mark price ticks, exchange timestamp.
    - `positions/{posId}`: Open position contracts, average entry ticks, margin string, accrued funding, stop/target ticks, entry guardrail snapshot (no per-tick Firestore writes for floating mark PnL).
    - `trades/{tradeId}`: Immutable (`allow update, delete: if false`), doc ID = `tradeId`, full entry/exit snapshots, gross/fee/slippage/funding/net PnL strings, exit cause, `parameterVersionId`, exchange timestamps.
    - `versions/{versionId}`: Immutable (`allow update, delete: if false`), pinned signal/guardrail/strategy configuration.
    - `heldOutLogs/{logId}`: Immutable (`allow update, delete: if false`), logs every evaluation on the held-out final period to enforce single-look transparency.

- **Key Security Safeguards**:
  - **Strict Simulation Isolation**: Outbound Delta Exchange clients perform read-only `GET` requests exclusively with zero trading API keys; automated unit tests verify the paper broker imports no exchange order routes.
  - **Strict Token & Rule Enforcement**: Server paper endpoints require valid Firebase ID tokens checking `iss`, `aud`, `exp`, `sub`, and `email_verified === true`, enforce per-user session (max 5) and worker search (1 active) caps, validate all payloads with hand-written validators, and pair with shallow owner-only Firestore rules (`allow update, delete: if false` on immutable audit collections).
