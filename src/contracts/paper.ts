import type { UnitsString } from '../engine/decimal';
import type { GuardrailDecision, GuardrailThresholds } from '../engine/guardrails';
import type { ExplainStructuredOutput } from './explain';

export type PaperOrderSide = 'BUY' | 'SELL';
export type PaperPositionSide = 'LONG' | 'SHORT';
export type PaperOrderType = 'MARKET' | 'LIMIT';
export type PaperOrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
export type PaperExitReason =
  | 'STOP'
  | 'TARGET'
  | 'SIGNAL'
  | 'MANUAL'
  | 'LIQUIDATION'
  | 'KILL_SWITCH';

export interface PaperSignalSnapshot {
  score: number | null;
  volZ: number | null;
  trend: number | null;
  changePointsInWindow: number;
  lastChangePointAgeBars: number | null;
  candleCount: number;
}

export interface PaperGuardrailSnapshot {
  decision: GuardrailDecision;
  firedRules: string[];
  reasons: string[];
  thresholdsUsed: GuardrailThresholds;
  inputs: PaperSignalSnapshot;
}

export interface PaperContractSpec {
  symbol: string;
  productId: number;
  tickSizeStr: string;
  tickSizeUnits: UnitsString;
  contractValueStr: string;
  contractValueUnits: UnitsString;
  makerCommissionRateStr: string;
  makerRateUnits: UnitsString;
  takerCommissionRateStr: string;
  takerRateUnits: UnitsString;
  initialMarginStr: string;
  initialMarginRateUnits: UnitsString;
  initialMarginScalingFactorStr: string;
  initialMarginScalingUnits: UnitsString;
  maintenanceMarginStr: string;
  maintenanceMarginRateUnits: UnitsString;
  maintenanceMarginScalingFactorStr: string;
  maintenanceMarginScalingUnits: UnitsString;
  liquidationPenaltyFactorStr: string;
  liquidationPenaltyFactorUnits: UnitsString;
  defaultLeverage: number;
  rateExchangeIntervalSec: number;
  rateExchangeIntervalSource: 'api' | 'fallback_28800s';
}

export interface PaperStrategyParams {
  strategyId: 'baseline_trend_follow';
  trendEntryThreshold: number;
  stopVolMultiplier: number;
  targetVolMultiplier: number;
  defaultSizeFractionBps: number;
}

export interface PaperParameterVersion {
  versionId: string;
  label: string;
  createdAtSec: number;
  regimeOptions: {
    volWindow: number;
    volLookback: number;
    trendWindow: number;
    cusumVolWindow: number;
    cusumK: number;
    cusumH: number;
    cusumDecayBars: number;
  };
  guardrailThresholds: GuardrailThresholds;
  strategyParams: PaperStrategyParams;
  baseSlippageTicks: number;
  fixedHalfSpreadTicks: number;
}

export interface PaperRiskLimits {
  maxRiskPerTradeBps: number; // default 100 (1.00%)
  maxOpenPositions: number; // default 3
  maxDailyLossBps: number; // default 500 (5.00%)
  maxDrawdownBps: number; // default 1500 (15.00%)
  maxLeverage: number; // default 5 (clamped <= product defaultLeverage)
}

export interface PaperAccount {
  sessionId: string;
  uid: string;
  symbol: string;
  resolution: '15m' | '1h';
  startingBalanceUnits: UnitsString;
  balanceUnits: UnitsString; // wallet cash balance excluding unrealized PnL & locked margin
  equityUnits: UnitsString; // balance + marginUsed + unrealizedPnl(markPrice)
  realizedPnlUnits: UnitsString;
  unrealizedPnlUnits: UnitsString;
  marginUsedUnits: UnitsString;
  peakEquityUnits: UnitsString;
  dailyStartEquityUnits: UnitsString;
  currentDayKey: string; // YYYY-MM-DD in resetTimeZone
  resetTimeZone: string; // valid IANA TZ string, default 'UTC'
  riskLimits: PaperRiskLimits;
  parameterVersionId: string;
  strategyEnabled: boolean;
  dailyLossHalted: boolean;
  drawdownHalted: boolean;
  killSwitchActive: boolean;
  stale: boolean;
  staleReason: string | null;
  lastProcessedCandleTime: number | null;
  lastFundingTime: number | null;
  lastMarkPriceTicks: number | null;
  heldOutInspectionCount: number;
  sessionVersion: number;
  createdAtSec: number;
  updatedAtSec: number;
}

export interface PaperOrder {
  clientOrderId: string;
  sessionId: string;
  symbol: string;
  side: PaperOrderSide;
  type: PaperOrderType;
  contracts: number;
  limitPriceTicks: number | null;
  stopLossTicks: number | null;
  takeProfitTicks: number | null;
  reduceOnly: boolean;
  status: PaperOrderStatus;
  rejectionReason: string | null;
  sourceKind: 'MANUAL' | 'STRATEGY' | 'STOP' | 'TARGET' | 'LIQUIDATION' | 'KILL_SWITCH';
  guardrail: PaperGuardrailSnapshot;
  parameterVersionId: string;
  createdAtSec: number;
  updatedAtSec: number;
}

export interface PaperFill {
  fillId: string;
  clientOrderId: string;
  sessionId: string;
  symbol: string;
  side: PaperOrderSide;
  contracts: number;
  priceTicks: number;
  markPriceTicks: number;
  slippageTicks: number;
  liquidityRole: 'maker' | 'taker';
  feeUnits: UnitsString;
  replayed: boolean;
  executedAtSec: number;
}

export interface PaperPosition {
  positionId: string;
  sessionId: string;
  symbol: string;
  side: PaperPositionSide;
  contracts: number;
  entryPriceTicks: number;
  markPriceTicks: number;
  liquidationPriceTicks: number;
  allocatedMarginUnits: UnitsString;
  maintenanceMarginUnits: UnitsString;
  unrealizedPnlUnits: UnitsString;
  accruedFundingUnits: UnitsString;
  entryFeesUnits: UnitsString;
  entrySlippageUnits: UnitsString;
  stopLossTicks: number | null;
  takeProfitTicks: number | null;
  parameterVersionId: string;
  entryGuardrail: PaperGuardrailSnapshot;
  openedAtSec: number;
  updatedAtSec: number;
}

export interface PaperClosedTrade {
  tradeId: string;
  sessionId: string;
  symbol: string;
  side: PaperPositionSide;
  contracts: number;
  entryPriceTicks: number;
  exitPriceTicks: number;
  grossPnlUnits: UnitsString;
  totalFeesUnits: UnitsString;
  totalSlippageUnits: UnitsString;
  fundingPnlUnits: UnitsString;
  liquidationPenaltyUnits: UnitsString;
  netPnlUnits: UnitsString;
  exitReason: PaperExitReason;
  replayed: boolean;
  parameterVersionId: string;
  entryGuardrail: PaperGuardrailSnapshot;
  exitGuardrail: PaperGuardrailSnapshot;
  openedAtSec: number;
  closedAtSec: number;
}

export interface HeldOutEvaluationLog {
  logId: string;
  sessionId: string;
  parameterVersionId: string;
  symbol: string;
  resolution: '15m' | '1h';
  inspectionIndex: number;
  evaluatedAtSec: number;
  tradeCount: number;
  netReturnPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  winRate: number | null;
  warningMessage: string | null;
}

export interface EquityPoint {
  time: number;
  equity: number;
  equityUnits: UnitsString;
}

export interface PaperSessionState {
  account: PaperAccount;
  contract: PaperContractSpec;
  activeVersion: PaperParameterVersion;
  versions: PaperParameterVersion[];
  openOrders: PaperOrder[];
  openPositions: PaperPosition[];
  recentFills: PaperFill[];
  closedTrades: PaperClosedTrade[];
  equityCurve: EquityPoint[];
  heldOutLogs: HeldOutEvaluationLog[];
}

export interface WilsonRange {
  low: number;
  high: number;
}

export interface BucketStats {
  bucket: string;
  tradeCount: number;
  wins: number;
  winRate: number | null;
  wilson95: WilsonRange | null;
  totalNetPnlUnits: UnitsString;
  expectancyUnits: UnitsString;
  insufficientSample: boolean;
}

export interface PaperTradeAnalytics {
  totalTrades: number;
  insufficientSample: boolean;
  minSampleThreshold: number;
  wins: number;
  losses: number;
  winRate: number | null;
  wilson95: WilsonRange | null;
  avgWinUnits: UnitsString;
  avgLossUnits: UnitsString;
  expectancyUnits: UnitsString;
  profitFactor: number | null;
  maxDrawdownPct: number;
  sharpeLike: number | null;
  totalNetPnlUnits: UnitsString;
  totalFeesUnits: UnitsString;
  totalSlippageUnits: UnitsString;
  totalFundingUnits: UnitsString;
  byGuardrail: BucketStats[];
  byScoreBucket: BucketStats[];
}

export interface WalkForwardSplitSummary {
  label: 'in_sample' | 'out_of_sample' | 'held_out';
  barCount: number;
  startSec: number;
  endSec: number;
  tradeCount: number;
  insufficientSample: boolean;
  netReturnPct: number;
  winRate: number | null;
  wilson95: WilsonRange | null;
  profitFactor: number | null;
  expectancyUnits: UnitsString;
  maxDrawdownPct: number;
}

export interface WalkForwardCandidateReport {
  candidateId: string;
  label: string;
  version: PaperParameterVersion;
  inSample: WalkForwardSplitSummary;
  outOfSample: WalkForwardSplitSummary;
  promoted: boolean;
  rejectionReason: string | null;
}

export interface WalkForwardReport {
  symbol: string;
  resolution: '15m' | '1h';
  totalBars: number;
  fixedHalfSpreadTicks: number;
  evaluatedCandidates: number;
  baselineCandidate: WalkForwardCandidateReport;
  bestCandidate: WalkForwardCandidateReport | null;
  candidates: WalkForwardCandidateReport[];
  heldOutWindow: {
    barCount: number;
    startSec: number;
    endSec: number;
  };
  generatedAtIso: string;
}

export interface PaperDriftReport {
  liveTradeCount: number;
  backtestTradeCount: number;
  liveWinRate: number | null;
  backtestWinRate: number | null;
  winRateDriftPctPts: number | null;
  liveAvgCostUnits: UnitsString;
  backtestAvgCostUnits: UnitsString;
  driftFlagged: boolean;
  driftReasons: string[];
}

export interface PaperRestoreSnapshotPayload {
  account: PaperAccount;
  contract: PaperContractSpec;
  activeVersion: PaperParameterVersion;
  versions: PaperParameterVersion[];
  openOrders: PaperOrder[];
  openPositions: PaperPosition[];
  recentFills: PaperFill[];
  closedTrades: PaperClosedTrade[];
  heldOutLogs: HeldOutEvaluationLog[];
}

export interface ExplainClosedTradeRequest {
  trade: PaperClosedTrade;
  contract: Pick<PaperContractSpec, 'symbol' | 'tickSizeStr' | 'contractValueStr'>;
}

export interface ExplainClosedTradeResponse {
  explanation: ExplainStructuredOutput;
  model: string;
  generatedAt: string;
  cached: boolean;
}
