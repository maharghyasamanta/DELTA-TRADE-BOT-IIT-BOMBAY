import type { DeltaProductSummary, DeltaTickerSnapshot } from '../contracts/delta';
import type {
  EquityPoint,
  PaperAccount,
  PaperClosedTrade,
  PaperContractSpec,
  PaperExitReason,
  PaperFill,
  PaperGuardrailSnapshot,
  PaperOrder,
  PaperOrderSide,
  PaperOrderType,
  PaperParameterVersion,
  PaperPosition,
  PaperPositionSide,
  PaperRiskLimits,
  PaperSessionState,
} from '../contracts/paper';
import {
  absBigInt,
  BPS_DENOM,
  divCeil,
  divFloor,
  FIXED_SCALE,
  maxBigInt,
  minBigInt,
  mulDivCeil,
  mulDivFloor,
  mulUnitsDown,
  mulUnitsUp,
  parseFixedUnits,
  parsePercentToRatioUnits,
  priceUnitsToTicks,
  stringToUnits,
  ticksToPriceUnits,
  unitsToDecimalNumber,
  unitsToString,
} from './decimal';
import {
  computeGuardrailSnapshotForCandles,
  createDefaultParameterVersion,
  getPaperStrategy,
} from './paperStrategy';
import type { CandlePoint } from './regime';

export const DEFAULT_STARTING_BALANCE_UNITS = 10_000n * FIXED_SCALE; // 10,000 USDT
export const DEFAULT_FUNDING_INTERVAL_SEC = 28_800; // 8 hours fallback if absent in product metadata
export const MAX_REPLAY_DOWNTIME_SEC = 7 * 86_400; // 7 days hard cap
export const MAX_EQUITY_CURVE_POINTS = 500;
export const MAX_STORED_FILLS = 500;

export const DEFAULT_RISK_LIMITS: PaperRiskLimits = {
  maxRiskPerTradeBps: 100, // 1.00%
  maxOpenPositions: 3,
  maxDailyLossBps: 500, // 5.00%
  maxDrawdownBps: 1500, // 15.00%
  maxLeverage: 5,
};

export interface LiveQuoteInput {
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  markPrice: number | null;
  bidSize: number | null;
  askSize: number | null;
  fundingRateRaw: string | null;
  exchangeTimeSec: number;
}

export interface SubmitOrderInput {
  clientOrderId: string;
  symbol: string;
  side: PaperOrderSide;
  type: PaperOrderType;
  contracts: number;
  limitPriceTicks?: number | null;
  stopLossTicks?: number | null;
  takeProfitTicks?: number | null;
  reduceOnly?: boolean;
  sourceKind?: PaperOrder['sourceKind'];
  guardrail: PaperGuardrailSnapshot;
  quote: LiveQuoteInput;
  replayed?: boolean;
}

export interface SubmitOrderResult {
  state: PaperSessionState;
  order: PaperOrder;
  fill: PaperFill | null;
  closedTrade: PaperClosedTrade | null;
  idempotentDuplicate: boolean;
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function getDayKeyInTimeZone(timestampSec: number, timeZone: string): string {
  const safeTz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const d = new Date(timestampSec * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function buildContractSpecFromProduct(product: DeltaProductSummary): PaperContractSpec {
  const tickSizeStr = product.tickSize && product.tickSize.trim() ? product.tickSize.trim() : '0.5';
  const contractValueStr =
    product.contractValue && product.contractValue.trim() ? product.contractValue.trim() : '0.001';
  const makerStr =
    product.makerCommissionRate && product.makerCommissionRate.trim()
      ? product.makerCommissionRate.trim()
      : '0.0002';
  const takerStr =
    product.takerCommissionRate && product.takerCommissionRate.trim()
      ? product.takerCommissionRate.trim()
      : '0.0005';
  const initialMarginStr =
    product.initialMargin && product.initialMargin.trim() ? product.initialMargin.trim() : '0.5';
  const initialScalingStr =
    product.initialMarginScalingFactor && product.initialMarginScalingFactor.trim()
      ? product.initialMarginScalingFactor.trim()
      : '0';
  const maintenanceMarginStr =
    product.maintenanceMargin && product.maintenanceMargin.trim()
      ? product.maintenanceMargin.trim()
      : '0.25';
  const maintenanceScalingStr =
    product.maintenanceMarginScalingFactor && product.maintenanceMarginScalingFactor.trim()
      ? product.maintenanceMarginScalingFactor.trim()
      : '0';
  const liqPenaltyStr =
    product.liquidationPenaltyFactor && product.liquidationPenaltyFactor.trim()
      ? product.liquidationPenaltyFactor.trim()
      : '0.5';

  const parsedDefaultLev = Number(product.defaultLeverage ?? 20);
  const defaultLeverage =
    Number.isFinite(parsedDefaultLev) && parsedDefaultLev >= 1 ? Math.floor(parsedDefaultLev) : 20;

  const hasApiRateInterval =
    typeof product.rateExchangeInterval === 'number' &&
    Number.isFinite(product.rateExchangeInterval) &&
    product.rateExchangeInterval > 0;
  const rateExchangeIntervalSec = hasApiRateInterval
    ? Math.floor(product.rateExchangeInterval!)
    : DEFAULT_FUNDING_INTERVAL_SEC;

  return {
    symbol: product.symbol,
    productId: product.id,
    tickSizeStr,
    tickSizeUnits: unitsToString(parseFixedUnits(tickSizeStr, 'up')),
    contractValueStr,
    contractValueUnits: unitsToString(parseFixedUnits(contractValueStr, 'trunc')),
    makerCommissionRateStr: makerStr,
    makerRateUnits: unitsToString(parseFixedUnits(makerStr, 'up')),
    takerCommissionRateStr: takerStr,
    takerRateUnits: unitsToString(parseFixedUnits(takerStr, 'up')),
    initialMarginStr,
    initialMarginRateUnits: unitsToString(parsePercentToRatioUnits(initialMarginStr)),
    initialMarginScalingFactorStr: initialScalingStr,
    initialMarginScalingUnits: unitsToString(parsePercentToRatioUnits(initialScalingStr)),
    maintenanceMarginStr,
    maintenanceMarginRateUnits: unitsToString(parsePercentToRatioUnits(maintenanceMarginStr)),
    maintenanceMarginScalingFactorStr: maintenanceScalingStr,
    maintenanceMarginScalingUnits: unitsToString(parsePercentToRatioUnits(maintenanceScalingStr)),
    liquidationPenaltyFactorStr: liqPenaltyStr,
    liquidationPenaltyFactorUnits: unitsToString(parseFixedUnits(liqPenaltyStr, 'up')),
    defaultLeverage,
    rateExchangeIntervalSec,
    rateExchangeIntervalSource: hasApiRateInterval ? 'api' : 'fallback_28800s',
  };
}

export function normalizeRiskLimits(
  input: Partial<PaperRiskLimits> | undefined,
  contractDefaultLeverage: number,
): PaperRiskLimits {
  const maxLevRaw = Math.max(1, Math.floor(input?.maxLeverage ?? DEFAULT_RISK_LIMITS.maxLeverage));
  const maxLeverage = Math.min(maxLevRaw, Math.max(1, Math.floor(contractDefaultLeverage)));
  return {
    maxRiskPerTradeBps: clampInt(
      input?.maxRiskPerTradeBps,
      10,
      2000,
      DEFAULT_RISK_LIMITS.maxRiskPerTradeBps,
    ),
    maxOpenPositions: clampInt(input?.maxOpenPositions, 1, 10, DEFAULT_RISK_LIMITS.maxOpenPositions),
    maxDailyLossBps: clampInt(input?.maxDailyLossBps, 50, 5000, DEFAULT_RISK_LIMITS.maxDailyLossBps),
    maxDrawdownBps: clampInt(input?.maxDrawdownBps, 100, 8000, DEFAULT_RISK_LIMITS.maxDrawdownBps),
    maxLeverage,
  };
}

function clampInt(val: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(val)));
}

export function createPaperSessionState(params: {
  sessionId: string;
  uid: string;
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  startingBalanceUnits?: string;
  resetTimeZone?: string;
  riskLimits?: Partial<PaperRiskLimits>;
  initialMarkPriceTicks?: number | null;
  createdAtSec: number;
  parameterVersion?: PaperParameterVersion;
}): PaperSessionState {
  const tz = params.resetTimeZone && isValidTimeZone(params.resetTimeZone)
    ? params.resetTimeZone.trim()
    : 'UTC';
  const startUnitsBig = params.startingBalanceUnits
    ? maxBigInt(FIXED_SCALE, stringToUnits(params.startingBalanceUnits))
    : DEFAULT_STARTING_BALANCE_UNITS;
  const startUnits = unitsToString(startUnitsBig);
  const version = params.parameterVersion ?? {
    ...createDefaultParameterVersion(),
    createdAtSec: params.createdAtSec,
  };
  const limits = normalizeRiskLimits(params.riskLimits, params.contract.defaultLeverage);

  const account: PaperAccount = {
    sessionId: params.sessionId,
    uid: params.uid,
    symbol: params.contract.symbol,
    resolution: params.resolution,
    startingBalanceUnits: startUnits,
    balanceUnits: startUnits,
    equityUnits: startUnits,
    realizedPnlUnits: '0',
    unrealizedPnlUnits: '0',
    marginUsedUnits: '0',
    peakEquityUnits: startUnits,
    dailyStartEquityUnits: startUnits,
    currentDayKey: getDayKeyInTimeZone(params.createdAtSec, tz),
    resetTimeZone: tz,
    riskLimits: limits,
    parameterVersionId: version.versionId,
    strategyEnabled: false,
    dailyLossHalted: false,
    drawdownHalted: false,
    killSwitchActive: false,
    stale: false,
    staleReason: null,
    lastProcessedCandleTime: null,
    lastFundingTime: params.createdAtSec,
    lastMarkPriceTicks: params.initialMarkPriceTicks ?? null,
    heldOutInspectionCount: 0,
    sessionVersion: 1,
    createdAtSec: params.createdAtSec,
    updatedAtSec: params.createdAtSec,
  };

  return {
    account,
    contract: params.contract,
    activeVersion: version,
    versions: [version],
    openOrders: [],
    openPositions: [],
    recentFills: [],
    closedTrades: [],
    equityCurve: [
      {
        time: params.createdAtSec,
        equity: unitsToDecimalNumber(startUnitsBig),
        equityUnits: startUnits,
      },
    ],
    heldOutLogs: [],
  };
}

export function quoteFromTickerSnapshot(
  ticker: DeltaTickerSnapshot,
  fallbackTimeSec: number,
): LiveQuoteInput {
  const exchangeTimeSec =
    typeof ticker.exchangeTimestampUs === 'number' && Number.isFinite(ticker.exchangeTimestampUs)
      ? Math.floor(ticker.exchangeTimestampUs / 1_000_000)
      : fallbackTimeSec;

  return {
    bestBidPrice: ticker.bestBid ?? ticker.close ?? ticker.markPrice,
    bestAskPrice: ticker.bestAsk ?? ticker.close ?? ticker.markPrice,
    markPrice: ticker.markPrice ?? ticker.close,
    bidSize: ticker.bidSize,
    askSize: ticker.askSize,
    fundingRateRaw: ticker.fundingRateRaw ?? (ticker.fundingRate !== null ? String(ticker.fundingRate) : null),
    exchangeTimeSec,
  };
}

export function computeNotionalUnits(
  contracts: number,
  priceTicks: number,
  contract: PaperContractSpec,
): bigint {
  const tickSize = stringToUnits(contract.tickSizeUnits);
  const contractVal = stringToUnits(contract.contractValueUnits);
  const priceUnits = ticksToPriceUnits(priceTicks, tickSize);
  const qtyUnits = BigInt(contracts) * contractVal;
  return mulUnitsDown(priceUnits, qtyUnits);
}

/**
 * Delta Exchange scaled initial & maintenance margin:
 * effectiveRate = min(1.0, baseRate + (notional / 1.0) * scalingFactor)
 * marginReq = mulUnitsUp(notional, effectiveRate) (rounded UP).
 */
export function computeScaledMarginUnits(
  notionalUnits: bigint,
  baseRateUnits: bigint,
  scalingFactorUnits: bigint,
  minLeverageCapRatioUnits = 0n,
): bigint {
  if (notionalUnits <= 0n) return 0n;
  const notionalUsdWholeUnits = notionalUnits; // already 10^8 scale representing USD notional
  const scalingAdd = mulUnitsUp(notionalUsdWholeUnits, scalingFactorUnits);
  let effectiveRate = baseRateUnits + scalingAdd;
  if (minLeverageCapRatioUnits > effectiveRate) {
    effectiveRate = minLeverageCapRatioUnits;
  }
  if (effectiveRate > FIXED_SCALE) {
    effectiveRate = FIXED_SCALE;
  }
  return mulUnitsUp(notionalUnits, effectiveRate);
}

export function computeMaintenanceMarginUnits(
  contracts: number,
  markPriceTicks: number,
  contract: PaperContractSpec,
): bigint {
  const notionalUnits = computeNotionalUnits(contracts, markPriceTicks, contract);
  return computeScaledMarginUnits(
    notionalUnits,
    stringToUnits(contract.maintenanceMarginRateUnits),
    stringToUnits(contract.maintenanceMarginScalingUnits),
  );
}

export function computeInitialMarginRequiredUnits(
  contracts: number,
  priceTicks: number,
  contract: PaperContractSpec,
  maxLeverage: number,
): bigint {
  const notionalUnits = computeNotionalUnits(contracts, priceTicks, contract);
  const leverageMinRate = divCeil(FIXED_SCALE, BigInt(Math.max(1, maxLeverage)));
  return computeScaledMarginUnits(
    notionalUnits,
    stringToUnits(contract.initialMarginRateUnits),
    stringToUnits(contract.initialMarginScalingUnits),
    leverageMinRate,
  );
}

/**
 * Conservative signed PnL using mark/exit price vs entry price:
 * Positive payouts round DOWN (floor); negative losses round DOWN (toward -Infinity = larger loss).
 */
export function computeSignedPnlUnits(
  side: PaperPositionSide,
  contracts: number,
  entryPriceTicks: number,
  exitOrMarkTicks: number,
  contract: PaperContractSpec,
): bigint {
  const tickSize = stringToUnits(contract.tickSizeUnits);
  const contractVal = stringToUnits(contract.contractValueUnits);
  const diffTicks =
    side === 'LONG' ? exitOrMarkTicks - entryPriceTicks : entryPriceTicks - exitOrMarkTicks;
  const priceDiffUnits = BigInt(diffTicks) * tickSize;
  const qtyUnits = BigInt(contracts) * contractVal;
  return mulUnitsDown(priceDiffUnits, qtyUnits);
}

export function computeSlippageTicks(
  baseSlippageTicks: number,
  contracts: number,
  availableBookSize: number | null,
): number {
  const base = Math.max(1, Math.floor(baseSlippageTicks));
  if (availableBookSize !== null && Number.isFinite(availableBookSize) && availableBookSize > 0) {
    if (contracts > availableBookSize) {
      const ratioMult = Math.ceil((contracts - availableBookSize) / availableBookSize);
      return Math.min(25, base + ratioMult * base);
    }
  }
  return base;
}

export function computeSlippageCostUnits(
  contracts: number,
  slippageTicks: number,
  contract: PaperContractSpec,
): bigint {
  if (slippageTicks <= 0 || contracts <= 0) return 0n;
  const tickSize = stringToUnits(contract.tickSizeUnits);
  const contractVal = stringToUnits(contract.contractValueUnits);
  const slipPriceDiff = BigInt(slippageTicks) * tickSize;
  const qtyUnits = BigInt(contracts) * contractVal;
  return mulUnitsUp(slipPriceDiff, qtyUnits); // slippage cost rounds UP
}

export function computeEstimatedLiquidationPriceTicks(
  pos: Pick<PaperPosition, 'side' | 'contracts' | 'entryPriceTicks' | 'allocatedMarginUnits' | 'maintenanceMarginUnits'>,
  contract: PaperContractSpec,
): number {
  const tickSize = stringToUnits(contract.tickSizeUnits);
  const contractVal = stringToUnits(contract.contractValueUnits);
  const qtyUnits = BigInt(pos.contracts) * contractVal;
  if (qtyUnits <= 0n || tickSize <= 0n) return pos.entryPriceTicks;

  const allocMargin = stringToUnits(pos.allocatedMarginUnits);
  const mm = stringToUnits(pos.maintenanceMarginUnits);
  const bufferUsd = maxBigInt(0n, allocMargin - mm);
  const deltaPriceUnits = mulDivFloor(bufferUsd, FIXED_SCALE, qtyUnits);
  const deltaTicks = Number(divFloor(deltaPriceUnits, tickSize));

  return pos.side === 'LONG'
    ? Math.max(1, pos.entryPriceTicks - deltaTicks)
    : pos.entryPriceTicks + deltaTicks;
}

function cloneState(state: PaperSessionState): PaperSessionState {
  return {
    account: { ...state.account, riskLimits: { ...state.account.riskLimits } },
    contract: { ...state.contract },
    activeVersion: { ...state.activeVersion },
    versions: [...state.versions],
    openOrders: state.openOrders.map((o) => ({ ...o })),
    openPositions: state.openPositions.map((p) => ({ ...p })),
    recentFills: [...state.recentFills],
    closedTrades: [...state.closedTrades],
    equityCurve: [...state.equityCurve],
    heldOutLogs: [...state.heldOutLogs],
  };
}

function bumpSessionVersion(state: PaperSessionState): void {
  const prev =
    typeof state.account.sessionVersion === 'number' &&
    Number.isInteger(state.account.sessionVersion) &&
    state.account.sessionVersion >= 1
      ? state.account.sessionVersion
      : 1;
  state.account.sessionVersion = prev + 1;
}

function appendEquityPoint(state: PaperSessionState, timeSec: number): void {
  const eq = state.account.equityUnits;
  const pt: EquityPoint = {
    time: timeSec,
    equity: unitsToDecimalNumber(stringToUnits(eq)),
    equityUnits: eq,
  };
  const last = state.equityCurve[state.equityCurve.length - 1];
  if (last && last.time === timeSec) {
    state.equityCurve[state.equityCurve.length - 1] = pt;
  } else {
    state.equityCurve.push(pt);
    if (state.equityCurve.length > MAX_EQUITY_CURVE_POINTS) {
      state.equityCurve = state.equityCurve.slice(-MAX_EQUITY_CURVE_POINTS);
    }
  }
}

function refreshAccountAndRiskState(
  state: PaperSessionState,
  markTicks: number,
  exchangeTimeSec: number,
): void {
  const acct = state.account;
  acct.lastMarkPriceTicks = markTicks;
  acct.updatedAtSec = exchangeTimeSec;

  // Daily-loss halt rollover check strictly against exchange timestamp & IANA timezone
  const dayKey = getDayKeyInTimeZone(exchangeTimeSec, acct.resetTimeZone);
  if (dayKey !== acct.currentDayKey) {
    acct.currentDayKey = dayKey;
    acct.dailyLossHalted = false;
    acct.dailyStartEquityUnits = acct.equityUnits;
  }

  let totalUnrealized = 0n;
  let totalMarginUsed = 0n;

  for (const pos of state.openPositions) {
    const uPnl = computeSignedPnlUnits(
      pos.side,
      pos.contracts,
      pos.entryPriceTicks,
      markTicks,
      state.contract,
    );
    const mm = computeMaintenanceMarginUnits(pos.contracts, markTicks, state.contract);
    pos.markPriceTicks = markTicks;
    pos.unrealizedPnlUnits = unitsToString(uPnl);
    pos.maintenanceMarginUnits = unitsToString(mm);
    pos.liquidationPriceTicks = computeEstimatedLiquidationPriceTicks(pos, state.contract);
    pos.updatedAtSec = exchangeTimeSec;

    totalUnrealized += uPnl;
    totalMarginUsed += stringToUnits(pos.allocatedMarginUnits);
  }

  const balance = stringToUnits(acct.balanceUnits);
  const equity = balance + totalMarginUsed + totalUnrealized;
  acct.marginUsedUnits = unitsToString(totalMarginUsed);
  acct.unrealizedPnlUnits = unitsToString(totalUnrealized);
  acct.equityUnits = unitsToString(equity);

  const peak = stringToUnits(acct.peakEquityUnits);
  if (equity > peak) {
    acct.peakEquityUnits = unitsToString(equity);
  }

  const currentPeak = stringToUnits(acct.peakEquityUnits);
  if (currentPeak > 0n) {
    const ddLimit = mulDivFloor(
      currentPeak,
      BigInt(acct.riskLimits.maxDrawdownBps),
      BPS_DENOM,
    );
    if (currentPeak - equity >= ddLimit) {
      acct.drawdownHalted = true;
    }
  }

  const dailyStart = stringToUnits(acct.dailyStartEquityUnits);
  if (dailyStart > 0n) {
    const dailyLimit = mulDivFloor(
      dailyStart,
      BigInt(acct.riskLimits.maxDailyLossBps),
      BPS_DENOM,
    );
    if (dailyStart - equity >= dailyLimit) {
      acct.dailyLossHalted = true;
    }
  }

  appendEquityPoint(state, exchangeTimeSec);
}

function makeDeterministicId(prefix: string, ...parts: Array<string | number>): string {
  const clean = parts
    .map((p) => String(p).replace(/[^a-zA-Z0-9_-]/g, '_'))
    .join('_');
  return `${prefix}_${clean}`.slice(0, 128);
}

function executeExitPosition(params: {
  state: PaperSessionState;
  posIndex: number;
  contractsToClose: number;
  fillPriceTicks: number;
  markPriceTicks: number;
  slippageTicks: number;
  liquidityRole: 'maker' | 'taker';
  exitReason: PaperExitReason;
  guardrail: PaperGuardrailSnapshot;
  clientOrderId: string;
  exchangeTimeSec: number;
  replayed: boolean;
}): { fill: PaperFill; closedTrade: PaperClosedTrade } {
  const {
    state,
    posIndex,
    contractsToClose,
    fillPriceTicks,
    markPriceTicks,
    slippageTicks,
    liquidityRole,
    exitReason,
    guardrail,
    clientOrderId,
    exchangeTimeSec,
    replayed,
  } = params;

  const pos = state.openPositions[posIndex];
  const closeCount = Math.min(pos.contracts, contractsToClose);
  const isFullClose = closeCount === pos.contracts;

  const exitNotional = computeNotionalUnits(closeCount, fillPriceTicks, state.contract);
  const feeRate =
    liquidityRole === 'maker'
      ? stringToUnits(state.contract.makerRateUnits)
      : stringToUnits(state.contract.takerRateUnits);
  const exitFeeUnits = mulUnitsUp(exitNotional, feeRate);
  const exitSlippageUnits = computeSlippageCostUnits(closeCount, slippageTicks, state.contract);

  // Proportional share of allocated margin, entry fees, entry slippage, accrued funding
  const allocMarginTotal = stringToUnits(pos.allocatedMarginUnits);
  const allocMarginReleased = isFullClose
    ? allocMarginTotal
    : mulDivFloor(allocMarginTotal, BigInt(closeCount), BigInt(pos.contracts));

  const entryFeeTotal = stringToUnits(pos.entryFeesUnits);
  const entryFeeShare = isFullClose
    ? entryFeeTotal
    : mulDivCeil(entryFeeTotal, BigInt(closeCount), BigInt(pos.contracts));

  const entrySlipTotal = stringToUnits(pos.entrySlippageUnits);
  const entrySlipShare = isFullClose
    ? entrySlipTotal
    : mulDivCeil(entrySlipTotal, BigInt(closeCount), BigInt(pos.contracts));

  const fundingTotal = stringToUnits(pos.accruedFundingUnits);
  const fundingShare = isFullClose
    ? fundingTotal
    : mulDivFloor(fundingTotal, BigInt(closeCount), BigInt(pos.contracts));

  const grossPnl = computeSignedPnlUnits(
    pos.side,
    closeCount,
    pos.entryPriceTicks,
    fillPriceTicks,
    state.contract,
  );

  let liquidationPenalty = 0n;
  if (exitReason === 'LIQUIDATION') {
    const mmShare = computeMaintenanceMarginUnits(closeCount, markPriceTicks, state.contract);
    liquidationPenalty = mulUnitsUp(
      mmShare,
      stringToUnits(state.contract.liquidationPenaltyFactorUnits),
    );
  }

  const totalFees = entryFeeShare + exitFeeUnits;
  const totalSlippage = entrySlipShare + exitSlippageUnits;
  // Note: entryFeeShare and fundingShare already hit wallet balance when opened/settled;
  // netPnl includes all costs for accurate trade-journal PnL.
  const netPnl = grossPnl - totalFees - liquidationPenalty + fundingShare;

  // Cash returned to wallet balance at close:
  const balanceDelta = allocMarginReleased + grossPnl - exitFeeUnits - liquidationPenalty;
  const nextBalance = stringToUnits(state.account.balanceUnits) + balanceDelta;
  state.account.balanceUnits = unitsToString(nextBalance);

  // Update realized PnL with the close portion (entry fee & funding were already booked into realizedPnl)
  const closeRealizedDelta = grossPnl - exitFeeUnits - liquidationPenalty;
  state.account.realizedPnlUnits = unitsToString(
    stringToUnits(state.account.realizedPnlUnits) + closeRealizedDelta,
  );

  const exitSide: PaperOrderSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
  const fillId = makeDeterministicId('fill', clientOrderId, exchangeTimeSec, closeCount);
  const fill: PaperFill = {
    fillId,
    clientOrderId,
    sessionId: state.account.sessionId,
    symbol: pos.symbol,
    side: exitSide,
    contracts: closeCount,
    priceTicks: fillPriceTicks,
    markPriceTicks,
    slippageTicks,
    liquidityRole,
    feeUnits: unitsToString(exitFeeUnits),
    replayed,
    executedAtSec: exchangeTimeSec,
  };

  const tradeId = makeDeterministicId('trade', pos.positionId, clientOrderId, exchangeTimeSec);
  const closedTrade: PaperClosedTrade = {
    tradeId,
    sessionId: state.account.sessionId,
    symbol: pos.symbol,
    side: pos.side,
    contracts: closeCount,
    entryPriceTicks: pos.entryPriceTicks,
    exitPriceTicks: fillPriceTicks,
    grossPnlUnits: unitsToString(grossPnl),
    totalFeesUnits: unitsToString(totalFees),
    totalSlippageUnits: unitsToString(totalSlippage),
    fundingPnlUnits: unitsToString(fundingShare),
    liquidationPenaltyUnits: unitsToString(liquidationPenalty),
    netPnlUnits: unitsToString(netPnl),
    exitReason,
    replayed,
    parameterVersionId: pos.parameterVersionId,
    entryGuardrail: pos.entryGuardrail,
    exitGuardrail: guardrail,
    openedAtSec: pos.openedAtSec,
    closedAtSec: exchangeTimeSec,
  };

  if (isFullClose) {
    state.openPositions.splice(posIndex, 1);
  } else {
    pos.contracts -= closeCount;
    pos.allocatedMarginUnits = unitsToString(allocMarginTotal - allocMarginReleased);
    pos.entryFeesUnits = unitsToString(maxBigInt(0n, entryFeeTotal - entryFeeShare));
    pos.entrySlippageUnits = unitsToString(maxBigInt(0n, entrySlipTotal - entrySlipShare));
    pos.accruedFundingUnits = unitsToString(fundingTotal - fundingShare);
    pos.updatedAtSec = exchangeTimeSec;
  }

  state.recentFills.unshift(fill);
  if (state.recentFills.length > MAX_STORED_FILLS) {
    state.recentFills = state.recentFills.slice(0, MAX_STORED_FILLS);
  }
  state.closedTrades.unshift(closedTrade);

  return { fill, closedTrade };
}

function openOrScalePosition(params: {
  state: PaperSessionState;
  side: PaperPositionSide;
  contracts: number;
  fillPriceTicks: number;
  markPriceTicks: number;
  slippageTicks: number;
  liquidityRole: 'maker' | 'taker';
  stopLossTicks: number | null;
  takeProfitTicks: number | null;
  guardrail: PaperGuardrailSnapshot;
  clientOrderId: string;
  exchangeTimeSec: number;
  replayed: boolean;
}): { fill: PaperFill; rejectedReason: string | null } {
  const {
    state,
    side,
    contracts,
    fillPriceTicks,
    markPriceTicks,
    slippageTicks,
    liquidityRole,
    stopLossTicks,
    takeProfitTicks,
    guardrail,
    clientOrderId,
    exchangeTimeSec,
    replayed,
  } = params;

  const notional = computeNotionalUnits(contracts, fillPriceTicks, state.contract);
  const feeRate =
    liquidityRole === 'maker'
      ? stringToUnits(state.contract.makerRateUnits)
      : stringToUnits(state.contract.takerRateUnits);
  const feeUnits = mulUnitsUp(notional, feeRate);
  const slipUnits = computeSlippageCostUnits(contracts, slippageTicks, state.contract);
  const reqMargin = computeInitialMarginRequiredUnits(
    contracts,
    fillPriceTicks,
    state.contract,
    state.account.riskLimits.maxLeverage,
  );

  const freeBalance = stringToUnits(state.account.balanceUnits);
  if (reqMargin + feeUnits > freeBalance) {
    return {
      fill: {
        fillId: '',
        clientOrderId,
        sessionId: state.account.sessionId,
        symbol: state.contract.symbol,
        side: side === 'LONG' ? 'BUY' : 'SELL',
        contracts,
        priceTicks: fillPriceTicks,
        markPriceTicks,
        slippageTicks,
        liquidityRole,
        feeUnits: unitsToString(feeUnits),
        replayed,
        executedAtSec: exchangeTimeSec,
      },
      rejectedReason: 'Insufficient free virtual balance for initial margin + fee requirement',
    };
  }

  // Risk-per-trade check if SL is present
  if (stopLossTicks !== null) {
    const equity = maxBigInt(0n, stringToUnits(state.account.equityUnits));
    const maxRiskUnits = mulDivFloor(
      equity,
      BigInt(state.account.riskLimits.maxRiskPerTradeBps),
      BPS_DENOM,
    );
    const tickSize = stringToUnits(state.contract.tickSizeUnits);
    const contractVal = stringToUnits(state.contract.contractValueUnits);
    const stopDistTicks = Math.abs(fillPriceTicks - stopLossTicks);
    const stopLossUsd = mulUnitsUp(BigInt(stopDistTicks) * tickSize, BigInt(contracts) * contractVal);
    if (stopLossUsd + feeUnits > maxRiskUnits) {
      return {
        fill: {
          fillId: '',
          clientOrderId,
          sessionId: state.account.sessionId,
          symbol: state.contract.symbol,
          side: side === 'LONG' ? 'BUY' : 'SELL',
          contracts,
          priceTicks: fillPriceTicks,
          markPriceTicks,
          slippageTicks,
          liquidityRole,
          feeUnits: unitsToString(feeUnits),
          replayed,
          executedAtSec: exchangeTimeSec,
        },
        rejectedReason: `Stop-loss risk exceeds maxRiskPerTrade (${(state.account.riskLimits.maxRiskPerTradeBps / 100).toFixed(2)}% of equity)`,
      };
    }
  }

  state.account.balanceUnits = unitsToString(freeBalance - reqMargin - feeUnits);
  state.account.realizedPnlUnits = unitsToString(
    stringToUnits(state.account.realizedPnlUnits) - feeUnits,
  );

  const existing = state.openPositions.find(
    (p) => p.symbol === state.contract.symbol && p.side === side,
  );

  if (existing) {
    const totalContracts = existing.contracts + contracts;
    const weightedNumerator =
      BigInt(existing.contracts) * BigInt(existing.entryPriceTicks) +
      BigInt(contracts) * BigInt(fillPriceTicks);
    // Conservative average entry: round UP for LONG, DOWN for SHORT
    existing.entryPriceTicks =
      side === 'LONG'
        ? Number(divCeil(weightedNumerator, BigInt(totalContracts)))
        : Number(divFloor(weightedNumerator, BigInt(totalContracts)));
    existing.contracts = totalContracts;
    existing.allocatedMarginUnits = unitsToString(
      stringToUnits(existing.allocatedMarginUnits) + reqMargin,
    );
    existing.entryFeesUnits = unitsToString(
      stringToUnits(existing.entryFeesUnits) + feeUnits,
    );
    existing.entrySlippageUnits = unitsToString(
      stringToUnits(existing.entrySlippageUnits) + slipUnits,
    );
    if (stopLossTicks !== null) existing.stopLossTicks = stopLossTicks;
    if (takeProfitTicks !== null) existing.takeProfitTicks = takeProfitTicks;
    existing.updatedAtSec = exchangeTimeSec;
  } else {
    const mm = computeMaintenanceMarginUnits(contracts, markPriceTicks, state.contract);
    const pos: PaperPosition = {
      positionId: makeDeterministicId('pos', state.account.sessionId, side, exchangeTimeSec),
      sessionId: state.account.sessionId,
      symbol: state.contract.symbol,
      side,
      contracts,
      entryPriceTicks: fillPriceTicks,
      markPriceTicks,
      liquidationPriceTicks: 1,
      allocatedMarginUnits: unitsToString(reqMargin),
      maintenanceMarginUnits: unitsToString(mm),
      unrealizedPnlUnits: unitsToString(
        computeSignedPnlUnits(side, contracts, fillPriceTicks, markPriceTicks, state.contract),
      ),
      accruedFundingUnits: '0',
      entryFeesUnits: unitsToString(feeUnits),
      entrySlippageUnits: unitsToString(slipUnits),
      stopLossTicks: stopLossTicks ?? null,
      takeProfitTicks: takeProfitTicks ?? null,
      parameterVersionId: state.activeVersion.versionId,
      entryGuardrail: guardrail,
      openedAtSec: exchangeTimeSec,
      updatedAtSec: exchangeTimeSec,
    };
    pos.liquidationPriceTicks = computeEstimatedLiquidationPriceTicks(pos, state.contract);
    state.openPositions.push(pos);
  }

  const fill: PaperFill = {
    fillId: makeDeterministicId('fill', clientOrderId, exchangeTimeSec, contracts),
    clientOrderId,
    sessionId: state.account.sessionId,
    symbol: state.contract.symbol,
    side: side === 'LONG' ? 'BUY' : 'SELL',
    contracts,
    priceTicks: fillPriceTicks,
    markPriceTicks,
    slippageTicks,
    liquidityRole,
    feeUnits: unitsToString(feeUnits),
    replayed,
    executedAtSec: exchangeTimeSec,
  };

  state.recentFills.unshift(fill);
  if (state.recentFills.length > MAX_STORED_FILLS) {
    state.recentFills = state.recentFills.slice(0, MAX_STORED_FILLS);
  }

  return { fill, rejectedReason: null };
}

function getQuoteTicks(quote: LiveQuoteInput, contract: PaperContractSpec): {
  bidTicks: number;
  askTicks: number;
  markTicks: number;
} {
  const tickSize = stringToUnits(contract.tickSizeUnits);
  const rawMark = quote.markPrice ?? quote.bestAskPrice ?? quote.bestBidPrice;
  if (rawMark === null || !Number.isFinite(rawMark) || rawMark <= 0) {
    throw new Error('Valid mark or quote price is required for paper execution');
  }
  const markUnits = parseFixedUnits(rawMark, 'trunc');
  const markTicks = Math.max(1, priceUnitsToTicks(markUnits, tickSize, 'nearest'));

  const bidPrice = quote.bestBidPrice ?? rawMark;
  const askPrice = quote.bestAskPrice ?? rawMark;
  const bidTicks = Math.max(1, priceUnitsToTicks(parseFixedUnits(bidPrice, 'down'), tickSize, 'down'));
  const askTicks = Math.max(
    bidTicks,
    priceUnitsToTicks(parseFixedUnits(askPrice, 'up'), tickSize, 'up'),
  );
  return { bidTicks, askTicks, markTicks };
}

export function submitPaperOrder(
  prevState: PaperSessionState,
  input: SubmitOrderInput,
): SubmitOrderResult {
  const existingOrder = prevState.openOrders.find((o) => o.clientOrderId === input.clientOrderId);
  const existingFill = prevState.recentFills.find((f) => f.clientOrderId === input.clientOrderId);
  if (existingOrder || existingFill) {
    return {
      state: prevState,
      order:
        existingOrder ??
        ({
          clientOrderId: input.clientOrderId,
          sessionId: prevState.account.sessionId,
          symbol: input.symbol,
          side: input.side,
          type: input.type,
          contracts: input.contracts,
          limitPriceTicks: input.limitPriceTicks ?? null,
          stopLossTicks: input.stopLossTicks ?? null,
          takeProfitTicks: input.takeProfitTicks ?? null,
          reduceOnly: Boolean(input.reduceOnly),
          status: 'FILLED',
          rejectionReason: null,
          sourceKind: input.sourceKind ?? 'MANUAL',
          guardrail: input.guardrail,
          parameterVersionId: prevState.activeVersion.versionId,
          createdAtSec: existingFill?.executedAtSec ?? input.quote.exchangeTimeSec,
          updatedAtSec: existingFill?.executedAtSec ?? input.quote.exchangeTimeSec,
        } satisfies PaperOrder),
      fill: existingFill ?? null,
      closedTrade: null,
      idempotentDuplicate: true,
    };
  }

  const state = cloneState(prevState);
  const nowSec = input.quote.exchangeTimeSec;
  const { bidTicks, askTicks, markTicks } = getQuoteTicks(input.quote, state.contract);

  refreshAccountAndRiskState(state, markTicks, nowSec);

  const reject = (reason: string): SubmitOrderResult => {
    const rejectedOrder: PaperOrder = {
      clientOrderId: input.clientOrderId,
      sessionId: state.account.sessionId,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      contracts: input.contracts,
      limitPriceTicks: input.limitPriceTicks ?? null,
      stopLossTicks: input.stopLossTicks ?? null,
      takeProfitTicks: input.takeProfitTicks ?? null,
      reduceOnly: Boolean(input.reduceOnly),
      status: 'REJECTED',
      rejectionReason: reason,
      sourceKind: input.sourceKind ?? 'MANUAL',
      guardrail: input.guardrail,
      parameterVersionId: state.activeVersion.versionId,
      createdAtSec: nowSec,
      updatedAtSec: nowSec,
    };
    return {
      state,
      order: rejectedOrder,
      fill: null,
      closedTrade: null,
      idempotentDuplicate: false,
    };
  };

  if (input.contracts <= 0 || !Number.isInteger(input.contracts)) {
    return reject('Contracts must be a positive integer');
  }
  if (state.account.stale) {
    return reject('Session is stale (>7d offline) — reset session before trading');
  }
  if (state.account.killSwitchActive && !input.reduceOnly) {
    return reject('Kill switch is active — reset kill switch before opening orders');
  }
  if (state.account.dailyLossHalted && !input.reduceOnly) {
    return reject('Daily loss halt active for current reset timezone day');
  }
  if (state.account.drawdownHalted && !input.reduceOnly) {
    return reject('Max drawdown halt active');
  }

  // Check if closing opposite side or opening new
  const desiredPosSide: PaperPositionSide = input.side === 'BUY' ? 'LONG' : 'SHORT';
  const oppositeSide: PaperPositionSide = input.side === 'BUY' ? 'SHORT' : 'LONG';
  const oppIndex = state.openPositions.findIndex(
    (p) => p.symbol === state.contract.symbol && p.side === oppositeSide,
  );

  // Guardrail gate on non-reduceOnly entries
  let allowedContracts = input.contracts;
  if (!input.reduceOnly && oppIndex === -1) {
    if (
      input.guardrail.decision === 'PAUSE' ||
      input.guardrail.decision === 'NO_DECISION'
    ) {
      return reject(
        `Entry blocked by guardrail ${input.guardrail.decision}: ${input.guardrail.reasons[0] ?? 'rule triggered'}`,
      );
    }
    if (input.guardrail.decision === 'REDUCE_SIZE') {
      allowedContracts = Math.floor(allowedContracts / 2);
      if (allowedContracts < 1) {
        return reject('Guardrail REDUCE_SIZE halved order size below 1 contract minimum');
      }
    }
    const sameOpen = state.openPositions.some(
      (p) => p.symbol === state.contract.symbol && p.side === desiredPosSide,
    );
    if (!sameOpen && state.openPositions.length >= state.account.riskLimits.maxOpenPositions) {
      return reject(
        `Max open positions (${state.account.riskLimits.maxOpenPositions}) reached`,
      );
    }
  }

  // Validate SL/TP orientation
  const refTicks = input.side === 'BUY' ? askTicks : bidTicks;
  if (input.stopLossTicks !== undefined && input.stopLossTicks !== null) {
    if (input.side === 'BUY' && input.stopLossTicks >= refTicks) {
      return reject('BUY stop-loss must be below entry reference price');
    }
    if (input.side === 'SELL' && input.stopLossTicks <= refTicks) {
      return reject('SELL stop-loss must be above entry reference price');
    }
  }
  if (input.takeProfitTicks !== undefined && input.takeProfitTicks !== null) {
    if (input.side === 'BUY' && input.takeProfitTicks <= refTicks) {
      return reject('BUY take-profit must be above entry reference price');
    }
    if (input.side === 'SELL' && input.takeProfitTicks >= refTicks) {
      return reject('SELL take-profit must be below entry reference price');
    }
  }

  if (input.type === 'LIMIT') {
    if (
      input.limitPriceTicks === undefined ||
      input.limitPriceTicks === null ||
      !Number.isInteger(input.limitPriceTicks) ||
      input.limitPriceTicks <= 0
    ) {
      return reject('LIMIT order requires a positive integer limitPriceTicks');
    }

    // Strict cross check on immediate submission: never fill on mere touch!
    const crossesImmediately =
      input.side === 'BUY' ? askTicks < input.limitPriceTicks : bidTicks > input.limitPriceTicks;

    if (!crossesImmediately) {
      const openOrder: PaperOrder = {
        clientOrderId: input.clientOrderId,
        sessionId: state.account.sessionId,
        symbol: input.symbol,
        side: input.side,
        type: 'LIMIT',
        contracts: allowedContracts,
        limitPriceTicks: input.limitPriceTicks,
        stopLossTicks: input.stopLossTicks ?? null,
        takeProfitTicks: input.takeProfitTicks ?? null,
        reduceOnly: Boolean(input.reduceOnly),
        status: 'OPEN',
        rejectionReason: null,
        sourceKind: input.sourceKind ?? 'MANUAL',
        guardrail: input.guardrail,
        parameterVersionId: state.activeVersion.versionId,
        createdAtSec: nowSec,
        updatedAtSec: nowSec,
      };
      state.openOrders.push(openOrder);
      bumpSessionVersion(state);
      return {
        state,
        order: openOrder,
        fill: null,
        closedTrade: null,
        idempotentDuplicate: false,
      };
    }
  }

  // Execute fill (Market or immediately crossing Limit)
  const isImmediateLimit = input.type === 'LIMIT' && input.limitPriceTicks != null;
  const bookSize = input.side === 'BUY' ? input.quote.askSize : input.quote.bidSize;
  const slipTicks = isImmediateLimit
    ? 0
    : computeSlippageTicks(state.activeVersion.baseSlippageTicks, allowedContracts, bookSize);
  const fillPriceTicks = isImmediateLimit
    ? (input.limitPriceTicks as number)
    : input.side === 'BUY'
      ? askTicks + slipTicks
      : Math.max(1, bidTicks - slipTicks);
  const role: 'maker' | 'taker' = isImmediateLimit ? 'maker' : 'taker';

  let fill: PaperFill | null = null;
  let closedTrade: PaperClosedTrade | null = null;

  if (oppIndex !== -1) {
    const oppPos = state.openPositions[oppIndex];
    const closeAmt = Math.min(oppPos.contracts, allowedContracts);
    const closedRes = executeExitPosition({
      state,
      posIndex: oppIndex,
      contractsToClose: closeAmt,
      fillPriceTicks,
      markPriceTicks: markTicks,
      slippageTicks: slipTicks,
      liquidityRole: role,
      exitReason: input.sourceKind === 'STRATEGY' ? 'SIGNAL' : 'MANUAL',
      guardrail: input.guardrail,
      clientOrderId: input.clientOrderId,
      exchangeTimeSec: nowSec,
      replayed: Boolean(input.replayed),
    });
    fill = closedRes.fill;
    closedTrade = closedRes.closedTrade;

    const remaining = allowedContracts - closeAmt;
    if (remaining > 0 && !input.reduceOnly) {
      const openRes = openOrScalePosition({
        state,
        side: desiredPosSide,
        contracts: remaining,
        fillPriceTicks,
        markPriceTicks: markTicks,
        slippageTicks: slipTicks,
        liquidityRole: role,
        stopLossTicks: input.stopLossTicks ?? null,
        takeProfitTicks: input.takeProfitTicks ?? null,
        guardrail: input.guardrail,
        clientOrderId: `${input.clientOrderId}_rem`,
        exchangeTimeSec: nowSec,
        replayed: Boolean(input.replayed),
      });
      if (openRes.rejectedReason) {
        return reject(openRes.rejectedReason);
      }
      fill = openRes.fill;
    }
  } else {
    if (input.reduceOnly) {
      return reject('Reduce-only order rejected: no opposing open position to reduce');
    }
    const openRes = openOrScalePosition({
      state,
      side: desiredPosSide,
      contracts: allowedContracts,
      fillPriceTicks,
      markPriceTicks: markTicks,
      slippageTicks: slipTicks,
      liquidityRole: role,
      stopLossTicks: input.stopLossTicks ?? null,
      takeProfitTicks: input.takeProfitTicks ?? null,
      guardrail: input.guardrail,
      clientOrderId: input.clientOrderId,
      exchangeTimeSec: nowSec,
      replayed: Boolean(input.replayed),
    });
    if (openRes.rejectedReason) {
      return reject(openRes.rejectedReason);
    }
    fill = openRes.fill;
  }

  refreshAccountAndRiskState(state, markTicks, nowSec);
  bumpSessionVersion(state);

  const filledOrder: PaperOrder = {
    clientOrderId: input.clientOrderId,
    sessionId: state.account.sessionId,
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    contracts: allowedContracts,
    limitPriceTicks: input.limitPriceTicks ?? null,
    stopLossTicks: input.stopLossTicks ?? null,
    takeProfitTicks: input.takeProfitTicks ?? null,
    reduceOnly: Boolean(input.reduceOnly),
    status: 'FILLED',
    rejectionReason: null,
    sourceKind: input.sourceKind ?? 'MANUAL',
    guardrail: input.guardrail,
    parameterVersionId: state.activeVersion.versionId,
    createdAtSec: nowSec,
    updatedAtSec: nowSec,
  };

  return {
    state,
    order: filledOrder,
    fill,
    closedTrade,
    idempotentDuplicate: false,
  };
}

export function cancelPaperOrder(
  prevState: PaperSessionState,
  clientOrderId: string,
  exchangeTimeSec: number,
): { state: PaperSessionState; cancelledOrder: PaperOrder | null } {
  const idx = prevState.openOrders.findIndex((o) => o.clientOrderId === clientOrderId);
  if (idx === -1) {
    return { state: prevState, cancelledOrder: null };
  }
  const state = cloneState(prevState);
  const [order] = state.openOrders.splice(idx, 1);
  order.status = 'CANCELLED';
  order.updatedAtSec = exchangeTimeSec;
  state.account.updatedAtSec = exchangeTimeSec;
  bumpSessionVersion(state);
  return { state, cancelledOrder: order };
}

function settleFundingIfDue(
  state: PaperSessionState,
  markPriceTicks: number,
  fundingRateRaw: string | null,
  exchangeTimeSec: number,
): boolean {
  const intervalSec = state.contract.rateExchangeIntervalSec || DEFAULT_FUNDING_INTERVAL_SEC;
  const lastFund = state.account.lastFundingTime ?? state.account.createdAtSec;
  if (exchangeTimeSec - lastFund < intervalSec) {
    return false;
  }

  const periodsElapsed = Math.floor((exchangeTimeSec - lastFund) / intervalSec);
  const nextFundingTime = lastFund + periodsElapsed * intervalSec;
  state.account.lastFundingTime = nextFundingTime;

  if (state.openPositions.length === 0 || !fundingRateRaw) {
    return true;
  }

  let fundingRateUnits: bigint;
  try {
    fundingRateUnits = parseFixedUnits(fundingRateRaw, 'trunc');
  } catch {
    return true;
  }
  if (fundingRateUnits === 0n) return true;

  for (let p = 0; p < periodsElapsed; p += 1) {
    for (const pos of state.openPositions) {
      const notional = computeNotionalUnits(pos.contracts, markPriceTicks, state.contract);
      const absRate = absBigInt(fundingRateUnits);
      const signedPositiveFlow =
        (pos.side === 'LONG' && fundingRateUnits < 0n) ||
        (pos.side === 'SHORT' && fundingRateUnits > 0n);

      // Receiver rounds DOWN; payer rounds UP
      const payment = signedPositiveFlow
        ? mulUnitsDown(notional, absRate)
        : -mulUnitsUp(notional, absRate);

      pos.accruedFundingUnits = unitsToString(stringToUnits(pos.accruedFundingUnits) + payment);
      state.account.balanceUnits = unitsToString(stringToUnits(state.account.balanceUnits) + payment);
      state.account.realizedPnlUnits = unitsToString(
        stringToUnits(state.account.realizedPnlUnits) + payment,
      );
    }
  }
  return true;
}

export function processLiveMarketTick(
  prevState: PaperSessionState,
  quote: LiveQuoteInput,
  guardrail: PaperGuardrailSnapshot,
): {
  state: PaperSessionState;
  lifecycleChanged: boolean;
  newFills: PaperFill[];
  newTrades: PaperClosedTrade[];
} {
  const state = cloneState(prevState);
  const { bidTicks, askTicks, markTicks } = getQuoteTicks(quote, state.contract);
  const nowSec = quote.exchangeTimeSec;
  const newFills: PaperFill[] = [];
  const newTrades: PaperClosedTrade[] = [];
  let lifecycleChanged = false;

  // 1. Check pending limit orders for STRICT price cross
  for (let i = state.openOrders.length - 1; i >= 0; i -= 1) {
    const ord = state.openOrders[i];
    if (ord.status !== 'OPEN' || ord.type !== 'LIMIT' || ord.limitPriceTicks === null) continue;
    const crossed =
      ord.side === 'BUY' ? askTicks < ord.limitPriceTicks : bidTicks > ord.limitPriceTicks;
    if (!crossed) continue;

    state.openOrders.splice(i, 1);
    const desiredSide: PaperPositionSide = ord.side === 'BUY' ? 'LONG' : 'SHORT';
    const oppSide: PaperPositionSide = ord.side === 'BUY' ? 'SHORT' : 'LONG';
    const oppIdx = state.openPositions.findIndex((p) => p.side === oppSide);

    if (oppIdx !== -1) {
      const res = executeExitPosition({
        state,
        posIndex: oppIdx,
        contractsToClose: Math.min(ord.contracts, state.openPositions[oppIdx].contracts),
        fillPriceTicks: ord.limitPriceTicks,
        markPriceTicks: markTicks,
        slippageTicks: 0,
        liquidityRole: 'maker',
        exitReason: 'MANUAL',
        guardrail,
        clientOrderId: ord.clientOrderId,
        exchangeTimeSec: nowSec,
        replayed: false,
      });
      newFills.push(res.fill);
      newTrades.push(res.closedTrade);
      lifecycleChanged = true;
    } else if (!ord.reduceOnly) {
      const openRes = openOrScalePosition({
        state,
        side: desiredSide,
        contracts: ord.contracts,
        fillPriceTicks: ord.limitPriceTicks,
        markPriceTicks: markTicks,
        slippageTicks: 0,
        liquidityRole: 'maker',
        stopLossTicks: ord.stopLossTicks,
        takeProfitTicks: ord.takeProfitTicks,
        guardrail: ord.guardrail,
        clientOrderId: ord.clientOrderId,
        exchangeTimeSec: nowSec,
        replayed: false,
      });
      if (!openRes.rejectedReason) {
        newFills.push(openRes.fill);
        lifecycleChanged = true;
      }
    }
  }

  // 2. Evaluate Stop-Loss -> Liquidation -> Take-Profit on open positions
  for (let i = state.openPositions.length - 1; i >= 0; i -= 1) {
    const pos = state.openPositions[i];
    const slip = computeSlippageTicks(
      state.activeVersion.baseSlippageTicks,
      pos.contracts,
      pos.side === 'LONG' ? quote.bidSize : quote.askSize,
    );

    // Stop check (using executable quote side: bid for LONG, ask for SHORT)
    if (pos.stopLossTicks !== null) {
      const stopTriggered =
        pos.side === 'LONG' ? bidTicks <= pos.stopLossTicks : askTicks >= pos.stopLossTicks;
      if (stopTriggered) {
        const stopFill =
          pos.side === 'LONG'
            ? Math.max(1, Math.min(bidTicks, pos.stopLossTicks) - slip)
            : Math.max(askTicks, pos.stopLossTicks) + slip;
        const res = executeExitPosition({
          state,
          posIndex: i,
          contractsToClose: pos.contracts,
          fillPriceTicks: stopFill,
          markPriceTicks: markTicks,
          slippageTicks: slip,
          liquidityRole: 'taker',
          exitReason: 'STOP',
          guardrail,
          clientOrderId: makeDeterministicId('sl', pos.positionId, nowSec),
          exchangeTimeSec: nowSec,
          replayed: false,
        });
        newFills.push(res.fill);
        newTrades.push(res.closedTrade);
        lifecycleChanged = true;
        continue;
      }
    }

    // Mark-price liquidation check (using Delta scaled maintenance margin)
    const uPnl = computeSignedPnlUnits(
      pos.side,
      pos.contracts,
      pos.entryPriceTicks,
      markTicks,
      state.contract,
    );
    const posEquity = stringToUnits(pos.allocatedMarginUnits) + uPnl;
    const mm = computeMaintenanceMarginUnits(pos.contracts, markTicks, state.contract);
    if (posEquity <= mm) {
      const liqFill =
        pos.side === 'LONG' ? Math.max(1, markTicks - slip) : markTicks + slip;
      const res = executeExitPosition({
        state,
        posIndex: i,
        contractsToClose: pos.contracts,
        fillPriceTicks: liqFill,
        markPriceTicks: markTicks,
        slippageTicks: slip,
        liquidityRole: 'taker',
        exitReason: 'LIQUIDATION',
        guardrail,
        clientOrderId: makeDeterministicId('liq', pos.positionId, nowSec),
        exchangeTimeSec: nowSec,
        replayed: false,
      });
      newFills.push(res.fill);
      newTrades.push(res.closedTrade);
      lifecycleChanged = true;
      continue;
    }

    // Take-Profit check
    if (pos.takeProfitTicks !== null) {
      const tpHit =
        pos.side === 'LONG' ? bidTicks >= pos.takeProfitTicks : askTicks <= pos.takeProfitTicks;
      if (tpHit) {
        const res = executeExitPosition({
          state,
          posIndex: i,
          contractsToClose: pos.contracts,
          fillPriceTicks: pos.takeProfitTicks,
          markPriceTicks: markTicks,
          slippageTicks: 0,
          liquidityRole: 'maker',
          exitReason: 'TARGET',
          guardrail,
          clientOrderId: makeDeterministicId('tp', pos.positionId, nowSec),
          exchangeTimeSec: nowSec,
          replayed: false,
        });
        newFills.push(res.fill);
        newTrades.push(res.closedTrade);
        lifecycleChanged = true;
      }
    }
  }

  // 3. Funding settlement at exchange rateExchangeIntervalSec
  if (settleFundingIfDue(state, markTicks, quote.fundingRateRaw, nowSec)) {
    lifecycleChanged = true;
  }

  // 4. Recompute mark-to-market equity & halt checks (never triggers Firestore write per tick!)
  refreshAccountAndRiskState(state, markTicks, nowSec);
  if (lifecycleChanged) {
    bumpSessionVersion(state);
  }

  return { state, lifecycleChanged, newFills, newTrades };
}

/**
 * Compute integer contracts obeying maxRiskPerTrade and maxLeverage and REDUCE_SIZE.
 */
export function computeStrategyOrderContracts(params: {
  state: PaperSessionState;
  entryPriceTicks: number;
  stopLossOffsetTicks: number | null;
  desiredSizeFractionBps: number;
  guardrailDecision: PaperGuardrailSnapshot['decision'];
}): number {
  const { state, entryPriceTicks, stopLossOffsetTicks, desiredSizeFractionBps, guardrailDecision } = params;
  if (guardrailDecision === 'PAUSE' || guardrailDecision === 'NO_DECISION') return 0;

  const equity = maxBigInt(0n, stringToUnits(state.account.equityUnits));
  const freeBal = maxBigInt(0n, stringToUnits(state.account.balanceUnits));
  if (equity <= 0n || freeBal <= 0n) return 0;

  const tickSize = stringToUnits(state.contract.tickSizeUnits);
  const contractVal = stringToUnits(state.contract.contractValueUnits);
  const perContractPriceUnits = ticksToPriceUnits(entryPriceTicks, tickSize);
  const perContractNotional = mulUnitsDown(perContractPriceUnits, contractVal);
  if (perContractNotional <= 0n) return 0;

  // Cap 1: Risk per trade
  const maxRiskUsd = mulDivFloor(
    equity,
    BigInt(state.account.riskLimits.maxRiskPerTradeBps),
    BPS_DENOM,
  );
  const effectiveStopTicks = Math.max(4, stopLossOffsetTicks ?? 20);
  const riskPerContract = mulUnitsUp(BigInt(effectiveStopTicks) * tickSize, contractVal);
  const maxByRisk = riskPerContract > 0n ? Number(divFloor(maxRiskUsd, riskPerContract)) : 0;

  // Cap 2: Free balance & leverage
  const minMarginPerContract = computeInitialMarginRequiredUnits(
    1,
    entryPriceTicks,
    state.contract,
    state.account.riskLimits.maxLeverage,
  );
  const feePerContract = mulUnitsUp(perContractNotional, stringToUnits(state.contract.takerRateUnits));
  const denom = minMarginPerContract + feePerContract;
  const maxByMargin = denom > 0n ? Number(divFloor(freeBal, denom)) : 0;

  let rawContracts = Math.min(maxByRisk, maxByMargin);
  rawContracts = Math.floor((rawContracts * Math.min(10_000, Math.max(100, desiredSizeFractionBps))) / 10_000);
  if (guardrailDecision === 'REDUCE_SIZE') {
    rawContracts = Math.floor(rawContracts / 2);
  }
  return Math.max(0, rawContracts);
}

/**
 * Evaluate a single closed bar step cleanly with ZERO lookahead:
 *  - Pending action from previous closed candle executes at THIS bar's open +/- halfSpread + slippage.
 *  - Inside this bar: STOP checks FIRST (gap-open at bar.open +/- slippage if open past stop, else stop +/- slippage),
 *    then MARK-candle liquidation, then TAKE-PROFIT, then LIMIT strict-cross.
 *  - Finally evaluates strategy on `candlesUpToThisBar` to queue next bar's action (or return decision).
 */
export function processBarStep(params: {
  state: PaperSessionState;
  tradeCandle: CandlePoint;
  markCandle: CandlePoint | null;
  closedHistoryUpToBar: readonly CandlePoint[];
  halfSpreadTicks: number;
  fundingRateRaw: string | null;
  replayed: boolean;
  pendingStrategyOrder?: {
    action: 'LONG' | 'SHORT' | 'FLAT';
    stopLossOffsetTicks: number | null;
    takeProfitOffsetTicks: number | null;
    desiredSizeFractionBps: number;
    guardrail: PaperGuardrailSnapshot;
  } | null;
}): {
  state: PaperSessionState;
  nextPendingOrder: {
    action: 'LONG' | 'SHORT' | 'FLAT';
    stopLossOffsetTicks: number | null;
    takeProfitOffsetTicks: number | null;
    desiredSizeFractionBps: number;
    guardrail: PaperGuardrailSnapshot;
  } | null;
  newFills: PaperFill[];
  newTrades: PaperClosedTrade[];
} {
  const state = cloneState(params.state);
  const { tradeCandle, markCandle, closedHistoryUpToBar, halfSpreadTicks, fundingRateRaw, replayed } = params;
  const tickSize = stringToUnits(state.contract.tickSizeUnits);
  const tickSizeNum = Number(state.contract.tickSizeStr) || 0.5;
  const barTime = tradeCandle.time;

  const toTicksDown = (p: number) =>
    Math.max(1, priceUnitsToTicks(parseFixedUnits(p, 'down'), tickSize, 'down'));
  const toTicksUp = (p: number) =>
    Math.max(1, priceUnitsToTicks(parseFixedUnits(p, 'up'), tickSize, 'up'));

  const openTicks = toTicksDown(tradeCandle.open);
  const highTicks = toTicksUp(tradeCandle.high);
  const lowTicks = toTicksDown(tradeCandle.low);
  const closeTicks = toTicksDown(tradeCandle.close);

  const mOpen = markCandle ? toTicksDown(markCandle.open) : openTicks;
  const mHigh = markCandle ? toTicksUp(markCandle.high) : highTicks;
  const mLow = markCandle ? toTicksDown(markCandle.low) : lowTicks;
  const mClose = markCandle ? toTicksDown(markCandle.close) : closeTicks;

  const newFills: PaperFill[] = [];
  const newTrades: PaperClosedTrade[] = [];

  const spread = Math.max(0, Math.floor(halfSpreadTicks));
  const openBid = Math.max(1, openTicks - spread);
  const openAsk = openTicks + spread;

  // Compute causal signal & guardrail on closed history up to this bar
  const { guardrail } = computeGuardrailSnapshotForCandles(
    closedHistoryUpToBar,
    state.activeVersion,
    tickSizeNum,
  );

  // 0. Execute pending order from prior closed candle at THIS bar's open
  if (
    params.pendingStrategyOrder &&
    !state.account.stale &&
    !state.account.killSwitchActive
  ) {
    const pending = params.pendingStrategyOrder;
    if (pending.action === 'FLAT') {
      for (let i = state.openPositions.length - 1; i >= 0; i -= 1) {
        const pos = state.openPositions[i];
        const slip = computeSlippageTicks(state.activeVersion.baseSlippageTicks, pos.contracts, null);
        const fillPrice =
          pos.side === 'LONG' ? Math.max(1, openBid - slip) : openAsk + slip;
        const exitRes = executeExitPosition({
          state,
          posIndex: i,
          contractsToClose: pos.contracts,
          fillPriceTicks: fillPrice,
          markPriceTicks: mOpen,
          slippageTicks: slip,
          liquidityRole: 'taker',
          exitReason: 'SIGNAL',
          guardrail: pending.guardrail,
          clientOrderId: makeDeterministicId('strat_exit', barTime, pos.positionId),
          exchangeTimeSec: barTime,
          replayed,
        });
        newFills.push(exitRes.fill);
        newTrades.push(exitRes.closedTrade);
      }
    } else if (
      !state.account.dailyLossHalted &&
      !state.account.drawdownHalted &&
      state.openPositions.length < state.account.riskLimits.maxOpenPositions &&
      pending.guardrail.decision === 'CONTINUE'
    ) {
      const entryRef = pending.action === 'LONG' ? openAsk : openBid;
      const contracts = computeStrategyOrderContracts({
        state,
        entryPriceTicks: entryRef,
        stopLossOffsetTicks: pending.stopLossOffsetTicks,
        desiredSizeFractionBps: pending.desiredSizeFractionBps,
        guardrailDecision: pending.guardrail.decision,
      });
      if (contracts >= 1) {
        const slip = computeSlippageTicks(state.activeVersion.baseSlippageTicks, contracts, null);
        const fillPrice =
          pending.action === 'LONG' ? entryRef + slip : Math.max(1, entryRef - slip);
        const slTicks =
          pending.stopLossOffsetTicks !== null
            ? pending.action === 'LONG'
              ? Math.max(1, fillPrice - pending.stopLossOffsetTicks)
              : fillPrice + pending.stopLossOffsetTicks
            : null;
        const tpTicks =
          pending.takeProfitOffsetTicks !== null
            ? pending.action === 'LONG'
              ? fillPrice + pending.takeProfitOffsetTicks
              : Math.max(1, fillPrice - pending.takeProfitOffsetTicks)
            : null;
        const openRes = openOrScalePosition({
          state,
          side: pending.action,
          contracts,
          fillPriceTicks: fillPrice,
          markPriceTicks: mOpen,
          slippageTicks: slip,
          liquidityRole: 'taker',
          stopLossTicks: slTicks,
          takeProfitTicks: tpTicks,
          guardrail: pending.guardrail,
          clientOrderId: makeDeterministicId('strat_entry', pending.action, barTime),
          exchangeTimeSec: barTime,
          replayed,
        });
        if (!openRes.rejectedReason) {
          newFills.push(openRes.fill);
        }
      }
    }
  }

  // 1. Check open LIMIT orders inside bar on STRICT cross
  for (let i = state.openOrders.length - 1; i >= 0; i -= 1) {
    const ord = state.openOrders[i];
    if (ord.status !== 'OPEN' || ord.type !== 'LIMIT' || ord.limitPriceTicks === null) continue;
    const crossed =
      ord.side === 'BUY' ? lowTicks < ord.limitPriceTicks : highTicks > ord.limitPriceTicks;
    if (!crossed) continue;

    state.openOrders.splice(i, 1);
    const desiredSide: PaperPositionSide = ord.side === 'BUY' ? 'LONG' : 'SHORT';
    const oppSide: PaperPositionSide = ord.side === 'BUY' ? 'SHORT' : 'LONG';
    const oppIdx = state.openPositions.findIndex((p) => p.side === oppSide);
    if (oppIdx !== -1) {
      const res = executeExitPosition({
        state,
        posIndex: oppIdx,
        contractsToClose: Math.min(ord.contracts, state.openPositions[oppIdx].contracts),
        fillPriceTicks: ord.limitPriceTicks,
        markPriceTicks: mClose,
        slippageTicks: 0,
        liquidityRole: 'maker',
        exitReason: 'MANUAL',
        guardrail,
        clientOrderId: ord.clientOrderId,
        exchangeTimeSec: barTime,
        replayed,
      });
      newFills.push(res.fill);
      newTrades.push(res.closedTrade);
    } else if (!ord.reduceOnly) {
      const openRes = openOrScalePosition({
        state,
        side: desiredSide,
        contracts: ord.contracts,
        fillPriceTicks: ord.limitPriceTicks,
        markPriceTicks: mClose,
        slippageTicks: 0,
        liquidityRole: 'maker',
        stopLossTicks: ord.stopLossTicks,
        takeProfitTicks: ord.takeProfitTicks,
        guardrail: ord.guardrail,
        clientOrderId: ord.clientOrderId,
        exchangeTimeSec: barTime,
        replayed,
      });
      if (!openRes.rejectedReason) {
        newFills.push(openRes.fill);
      }
    }
  }

  // 2. Intra-bar exits: STOP BEFORE TARGET (pessimistic ordering), gap-open check, and MARK liquidation
  for (let i = state.openPositions.length - 1; i >= 0; i -= 1) {
    const pos = state.openPositions[i];
    const slip = computeSlippageTicks(state.activeVersion.baseSlippageTicks, pos.contracts, null);

    // A) Stop-loss check FIRST
    if (pos.stopLossTicks !== null) {
      const gappedOpen =
        pos.side === 'LONG' ? openTicks <= pos.stopLossTicks : openTicks >= pos.stopLossTicks;
      const hitIntra =
        pos.side === 'LONG' ? lowTicks <= pos.stopLossTicks : highTicks >= pos.stopLossTicks;

      if (gappedOpen || hitIntra) {
        const baseExec = gappedOpen ? openTicks : pos.stopLossTicks;
        const stopFill =
          pos.side === 'LONG' ? Math.max(1, baseExec - slip) : baseExec + slip;
        const res = executeExitPosition({
          state,
          posIndex: i,
          contractsToClose: pos.contracts,
          fillPriceTicks: stopFill,
          markPriceTicks: mClose,
          slippageTicks: slip,
          liquidityRole: 'taker',
          exitReason: 'STOP',
          guardrail,
          clientOrderId: makeDeterministicId('bar_sl', pos.positionId, barTime),
          exchangeTimeSec: barTime,
          replayed,
        });
        newFills.push(res.fill);
        newTrades.push(res.closedTrade);
        continue;
      }
    }

    // B) Liquidation check using worst MARK candle excursion (mLow for LONG, mHigh for SHORT)
    const worstMark = pos.side === 'LONG' ? mLow : mHigh;
    const worstUpnl = computeSignedPnlUnits(
      pos.side,
      pos.contracts,
      pos.entryPriceTicks,
      worstMark,
      state.contract,
    );
    const worstEquity = stringToUnits(pos.allocatedMarginUnits) + worstUpnl;
    const mmAtWorst = computeMaintenanceMarginUnits(pos.contracts, worstMark, state.contract);
    if (worstEquity <= mmAtWorst) {
      const liqFill = pos.side === 'LONG' ? Math.max(1, worstMark - slip) : worstMark + slip;
      const res = executeExitPosition({
        state,
        posIndex: i,
        contractsToClose: pos.contracts,
        fillPriceTicks: liqFill,
        markPriceTicks: worstMark,
        slippageTicks: slip,
        liquidityRole: 'taker',
        exitReason: 'LIQUIDATION',
        guardrail,
        clientOrderId: makeDeterministicId('bar_liq', pos.positionId, barTime),
        exchangeTimeSec: barTime,
        replayed,
      });
      newFills.push(res.fill);
      newTrades.push(res.closedTrade);
      continue;
    }

    // C) Take-profit check AFTER stop & liquidation
    if (pos.takeProfitTicks !== null) {
      const tpHit =
        pos.side === 'LONG' ? highTicks >= pos.takeProfitTicks : lowTicks <= pos.takeProfitTicks;
      if (tpHit) {
        const res = executeExitPosition({
          state,
          posIndex: i,
          contractsToClose: pos.contracts,
          fillPriceTicks: pos.takeProfitTicks,
          markPriceTicks: mClose,
          slippageTicks: 0,
          liquidityRole: 'maker',
          exitReason: 'TARGET',
          guardrail,
          clientOrderId: makeDeterministicId('bar_tp', pos.positionId, barTime),
          exchangeTimeSec: barTime,
          replayed,
        });
        newFills.push(res.fill);
        newTrades.push(res.closedTrade);
      }
    }
  }

  // 3. Funding settlement & mark-to-market refresh
  settleFundingIfDue(state, mClose, fundingRateRaw, barTime);
  refreshAccountAndRiskState(state, mClose, barTime);
  state.account.lastProcessedCandleTime = barTime;

  // 4. Strategy evaluation strictly on closed candles[0..barIndex] for NEXT bar open
  let nextPendingOrder: {
    action: 'LONG' | 'SHORT' | 'FLAT';
    stopLossOffsetTicks: number | null;
    takeProfitOffsetTicks: number | null;
    desiredSizeFractionBps: number;
    guardrail: PaperGuardrailSnapshot;
  } | null = null;

  if (
    state.account.strategyEnabled &&
    !state.account.stale &&
    !state.account.killSwitchActive
  ) {
    const strategy = getPaperStrategy(state.activeVersion.strategyParams.strategyId);
    const currentPosition = state.openPositions[0] ?? null;
    const { signal: latestSignal, guardrail: latestGuardrail } = computeGuardrailSnapshotForCandles(
      closedHistoryUpToBar,
      state.activeVersion,
      tickSizeNum,
    );
    const decision = strategy.onCandle({
      closedCandles: closedHistoryUpToBar,
      signal: latestSignal,
      guardrail: latestGuardrail,
      currentPosition,
      tickSizeNum,
      params: state.activeVersion.strategyParams,
    });
    if (decision.action !== 'HOLD') {
      nextPendingOrder = {
        action: decision.action,
        stopLossOffsetTicks: decision.stopLossOffsetTicks,
        takeProfitOffsetTicks: decision.takeProfitOffsetTicks,
        desiredSizeFractionBps: decision.desiredSizeFractionBps,
        guardrail: latestGuardrail,
      };
    }
  }

  bumpSessionVersion(state);
  return { state, nextPendingOrder, newFills, newTrades };
}

/**
 * Reconnect catch-up replay: validates downtime <= 7 days, otherwise flags session stale & halts.
 * Replays missed closed trade candles + MARK: candles chronologically through both broker
 * stop/target/liquidation/funding AND the session's persisted parameter version strategy.
 */
export function replayMissedHistory(params: {
  snapshot: PaperSessionState;
  tradeCandles: readonly CandlePoint[];
  markCandles: readonly CandlePoint[];
  nowSec: number;
  fundingRateRaw: string | null;
}): {
  state: PaperSessionState;
  replayedBars: number;
  replayedFills: PaperFill[];
  replayedTrades: PaperClosedTrade[];
} {
  const { snapshot, tradeCandles, markCandles, nowSec, fundingRateRaw } = params;
  const lastTime = snapshot.account.lastProcessedCandleTime ?? snapshot.account.updatedAtSec;
  if (nowSec - lastTime > MAX_REPLAY_DOWNTIME_SEC) {
    const staleState = cloneState(snapshot);
    staleState.account.stale = true;
    staleState.account.strategyEnabled = false;
    staleState.account.staleReason = `Offline duration (${Math.floor((nowSec - lastTime) / 86_400)}d) exceeded 7-day catch-up limit. Reset session to resume.`;
    staleState.account.updatedAtSec = nowSec;
    bumpSessionVersion(staleState);
    return {
      state: staleState,
      replayedBars: 0,
      replayedFills: [],
      replayedTrades: [],
    };
  }

  const markByTime = new Map<number, CandlePoint>();
  for (const mc of markCandles) {
    markByTime.set(mc.time, mc);
  }

  const anchorTime = snapshot.account.lastProcessedCandleTime ?? snapshot.account.createdAtSec;
  let current = cloneState(snapshot);
  let pending: ReturnType<typeof processBarStep>['nextPendingOrder'] = null;
  let replayedBars = 0;
  const replayedFills: PaperFill[] = [];
  const replayedTrades: PaperClosedTrade[] = [];

  for (let i = 0; i < tradeCandles.length; i += 1) {
    const bar = tradeCandles[i];
    if (bar.time <= anchorTime) continue;

    const historySlice = tradeCandles.slice(0, i + 1);
    const step = processBarStep({
      state: current,
      tradeCandle: bar,
      markCandle: markByTime.get(bar.time) ?? null,
      closedHistoryUpToBar: historySlice,
      halfSpreadTicks: current.activeVersion.fixedHalfSpreadTicks,
      fundingRateRaw,
      replayed: true,
      pendingStrategyOrder: pending,
    });

    current = step.state;
    pending = step.nextPendingOrder;
    replayedBars += 1;
    replayedFills.push(...step.newFills);
    replayedTrades.push(...step.newTrades);
  }

  return {
    state: current,
    replayedBars,
    replayedFills,
    replayedTrades,
  };
}

export function triggerKillSwitch(
  prevState: PaperSessionState,
  quote: LiveQuoteInput,
  guardrail: PaperGuardrailSnapshot,
): {
  state: PaperSessionState;
  closedTrades: PaperClosedTrade[];
  cancelledOrders: PaperOrder[];
  fills: PaperFill[];
} {
  const state = cloneState(prevState);
  const nowSec = quote.exchangeTimeSec;
  const { bidTicks, askTicks, markTicks } = getQuoteTicks(quote, state.contract);

  const cancelledOrders: PaperOrder[] = [];
  for (const ord of state.openOrders) {
    cancelledOrders.push({
      ...ord,
      status: 'CANCELLED',
      updatedAtSec: nowSec,
    });
  }
  state.openOrders = [];

  const fills: PaperFill[] = [];
  const closedTrades: PaperClosedTrade[] = [];

  for (let i = state.openPositions.length - 1; i >= 0; i -= 1) {
    const pos = state.openPositions[i];
    const slip = computeSlippageTicks(
      state.activeVersion.baseSlippageTicks,
      pos.contracts,
      pos.side === 'LONG' ? quote.bidSize : quote.askSize,
    );
    const fillPrice =
      pos.side === 'LONG' ? Math.max(1, bidTicks - slip) : askTicks + slip;
    const res = executeExitPosition({
      state,
      posIndex: i,
      contractsToClose: pos.contracts,
      fillPriceTicks: fillPrice,
      markPriceTicks: markTicks,
      slippageTicks: slip,
      liquidityRole: 'taker',
      exitReason: 'KILL_SWITCH',
      guardrail,
      clientOrderId: makeDeterministicId('kill', pos.positionId, nowSec),
      exchangeTimeSec: nowSec,
      replayed: false,
    });
    fills.push(res.fill);
    closedTrades.push(res.closedTrade);
  }

  state.account.killSwitchActive = true;
  state.account.strategyEnabled = false;
  refreshAccountAndRiskState(state, markTicks, nowSec);
  bumpSessionVersion(state);

  return { state, closedTrades, cancelledOrders, fills };
}
