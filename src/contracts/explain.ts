export const EXPLAIN_SYSTEM_INSTRUCTION =
  'You are a read-only market-data telemetry narrator. Explain in plain, objective language what the provided numbers describe about the currently loaded candles and deterministic rule evaluation. Rules: (1) Use ONLY numbers that already appear in the provided input JSON (you may display rounded equivalents matching standard decimal display); never invent, estimate, extrapolate, or compute new numbers. (2) Do NOT predict future prices or outcomes, advise, recommend actions, or mention trades or execution. (3) Never use any of the words: buy, sell, long, short, enter, exit, order, position, guaranteed, or predict (use "trailing window" instead of "short window", and "so that" instead of "in order to"). (4) If any input metric is null, explicitly state that it is unavailable rather than guessing. (5) Keep summary concise (<= 360 characters), up to 5 keyPoints, and up to 3 cautions.';

export interface ExplainRegimeSnapshot {
  score: number | null;
  volZ: number | null;
  trend: number | null;
  changePointsInWindow: number;
  lastChangePointAgeBars: number | null;
}

export interface ExplainGuardrailThresholdsSnapshot {
  pauseScore: number;
  pauseVolZ: number;
  pauseChangePointAgeBars: number;
  reduceScore: number;
  reduceVolZ: number;
  reduceChangePointAgeBars: number;
}

export interface ExplainGuardrailSnapshot {
  decision: 'CONTINUE' | 'REDUCE_SIZE' | 'PAUSE' | 'NO_DECISION';
  firedRules: string[];
  reasons: string[];
  thresholdsUsed: ExplainGuardrailThresholdsSnapshot;
}

export interface ExplainWindowsSnapshot {
  volWindow: number;
  volLookback: number;
  trendWindow: number;
  cusumVolWindow: number;
  cusumK: number;
  cusumH: number;
  cusumDecayBars: number;
  weights: {
    volatility: number;
    trend: number;
    cusum: number;
  };
  requiredBarsForVolZ: number;
  requiredBarsForTrend: number;
  requiredBarsForCusum: number;
  skippedNonPositiveCloses: number;
}

export interface ExplainSnapshotRequest {
  source: 'Delta' | 'Alpaca';
  symbol: string;
  timeframe: string;
  candleCount: number;
  lastCandleTime: number | null;
  regime: ExplainRegimeSnapshot;
  guardrail: ExplainGuardrailSnapshot;
  windows: ExplainWindowsSnapshot;
}

export interface ExplainKeyPoint {
  label: string;
  valueText: string;
  meaning: string;
}

export interface ExplainStructuredOutput {
  summary: string;
  keyPoints: ExplainKeyPoint[];
  cautions: string[];
  unavailable: string[];
}

export interface ExplainResponseData {
  explanation: ExplainStructuredOutput;
  model: string;
  generatedAt: string;
}

export interface ExplainApiEnvelope {
  data: ExplainResponseData;
  source: 'Gemini (structured output)';
  cached: boolean;
}

export interface ExplainApiErrorResponse {
  error: string;
  code: string;
  status: number;
  source: 'Gemini Explain Proxy';
  timestamp: string;
  offendingNumbers?: number[];
  matchedWords?: string[];
}

export interface ExplainStatusResponse {
  configured: boolean;
  primaryModel: string;
  fallbackModel: string;
  primaryModelOk: boolean | null;
  fallbackModelOk: boolean | null;
  modelCheckError: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkedAt: string;
}

export type ExplainMode = 'market_snapshot' | 'paper_trade_review';

export const PAPER_TRADE_EXPLAIN_SYSTEM_INSTRUCTION =
  'You are a read-only historical trade-log narrator for simulated paper trades. Explain objectively in plain English what happened in this single completed simulated trade. Rules: (1) Use ONLY numbers already present in the input JSON (or their standard decimal rounded display); never invent or calculate new numbers. (2) You may describe the historical trade using past-tense terms ("long", "short", "entry", "exit") strictly for this completed simulated trade, but you MUST NOT recommend actions, give advice, or predict future price movements. (3) Never use the words: buy, sell, order, position, guaranteed, or predict. (4) Keep summary concise (<= 360 characters), up to 5 keyPoints, and up to 3 cautions.';

export interface PaperTradeExplainRequest {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  contracts: number;
  entryPriceDisplay: string;
  exitPriceDisplay: string;
  grossPnlDisplay: string;
  feesDisplay: string;
  slippageDisplay: string;
  fundingDisplay: string;
  liquidationPenaltyDisplay: string;
  netPnlDisplay: string;
  exitReason: string;
  openedAtSec: number;
  closedAtSec: number;
  parameterVersionId: string;
  entryGuardrailDecision: string;
  entryScore: number | null;
  entryVolZ: number | null;
  entryTrend: number | null;
  exitGuardrailDecision: string;
  exitScore: number | null;
  exitVolZ: number | null;
  exitTrend: number | null;
  entryFiredRules: string[];
  exitFiredRules: string[];
}
