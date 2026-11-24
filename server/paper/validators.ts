import type {
  PaperAccount,
  PaperClosedTrade,
  PaperContractSpec,
  PaperFill,
  PaperOrder,
  PaperParameterVersion,
  PaperPosition,
  PaperRestoreSnapshotPayload,
  PaperRiskLimits,
  HeldOutEvaluationLog,
  ExplainClosedTradeRequest,
} from '../../src/contracts/paper.ts';
import { isValidTimeZone } from '../../src/engine/paperBrokerEngine.ts';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SYMBOL_RE = /^[A-Za-z0-9._-]{1,40}$/;
const UNITS_RE = /^-?\d{1,38}$/;
const POSITIVE_DECIMAL_RE = /^\d+(?:\.\d{1,8})?$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isValidId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

export function isUnitsString(v: unknown): v is string {
  return typeof v === 'string' && UNITS_RE.test(v);
}

function isFiniteInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export interface CreateSessionInput {
  symbol: string;
  resolution: '15m' | '1h';
  startingBalanceUsdt?: string;
  resetTimeZone?: string;
  riskLimits?: Partial<PaperRiskLimits>;
}

export function validateCreateSessionInput(body: unknown): ValidationResult<CreateSessionInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  if (typeof body.symbol !== 'string' || !SYMBOL_RE.test(body.symbol.trim())) {
    return { ok: false, message: 'Invalid symbol' };
  }
  if (body.resolution !== '15m' && body.resolution !== '1h') {
    return { ok: false, message: 'resolution must be "15m" or "1h"' };
  }
  if (body.startingBalanceUsdt !== undefined) {
    if (
      typeof body.startingBalanceUsdt !== 'string' ||
      !POSITIVE_DECIMAL_RE.test(body.startingBalanceUsdt.trim()) ||
      Number(body.startingBalanceUsdt) < 100 ||
      Number(body.startingBalanceUsdt) > 10_000_000
    ) {
      return {
        ok: false,
        message: 'startingBalanceUsdt must be a decimal string between 100 and 10000000',
      };
    }
  }
  if (body.resetTimeZone !== undefined) {
    if (typeof body.resetTimeZone !== 'string' || !isValidTimeZone(body.resetTimeZone)) {
      return { ok: false, message: 'resetTimeZone must be a valid IANA timezone (e.g. "UTC")' };
    }
  }
  if (body.riskLimits !== undefined && !isPlainObject(body.riskLimits)) {
    return { ok: false, message: 'riskLimits must be an object' };
  }
  const rl = body.riskLimits as Record<string, unknown> | undefined;
  const riskLimits: Partial<PaperRiskLimits> | undefined = rl
    ? {
        ...(rl.maxRiskPerTradeBps !== undefined
          ? { maxRiskPerTradeBps: Number(rl.maxRiskPerTradeBps) }
          : {}),
        ...(rl.maxOpenPositions !== undefined
          ? { maxOpenPositions: Number(rl.maxOpenPositions) }
          : {}),
        ...(rl.maxDailyLossBps !== undefined
          ? { maxDailyLossBps: Number(rl.maxDailyLossBps) }
          : {}),
        ...(rl.maxDrawdownBps !== undefined
          ? { maxDrawdownBps: Number(rl.maxDrawdownBps) }
          : {}),
        ...(rl.maxLeverage !== undefined ? { maxLeverage: Number(rl.maxLeverage) } : {}),
      }
    : undefined;

  return {
    ok: true,
    value: {
      symbol: body.symbol.trim(),
      resolution: body.resolution,
      startingBalanceUsdt: body.startingBalanceUsdt?.trim(),
      resetTimeZone: typeof body.resetTimeZone === 'string' ? body.resetTimeZone.trim() : undefined,
      riskLimits,
    },
  };
}

export interface SubmitOrderRequestInput {
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  contracts: number;
  limitPriceTicks: number | null;
  stopLossTicks: number | null;
  takeProfitTicks: number | null;
  reduceOnly: boolean;
}

export function validateSubmitOrderInput(body: unknown): ValidationResult<SubmitOrderRequestInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  if (!isValidId(body.clientOrderId)) {
    return { ok: false, message: 'clientOrderId must match [a-zA-Z0-9_-]{1,128}' };
  }
  if (body.side !== 'BUY' && body.side !== 'SELL') {
    return { ok: false, message: 'side must be "BUY" or "SELL"' };
  }
  if (body.type !== 'MARKET' && body.type !== 'LIMIT') {
    return { ok: false, message: 'type must be "MARKET" or "LIMIT"' };
  }
  if (!isFiniteInt(body.contracts, 1, 100_000)) {
    return { ok: false, message: 'contracts must be an integer between 1 and 100000' };
  }
  const limitPriceTicks = body.limitPriceTicks ?? null;
  if (limitPriceTicks !== null && !isFiniteInt(limitPriceTicks, 1, 1_000_000_000)) {
    return { ok: false, message: 'limitPriceTicks must be null or a positive integer' };
  }
  if (body.type === 'LIMIT' && limitPriceTicks === null) {
    return { ok: false, message: 'LIMIT order requires limitPriceTicks' };
  }
  const stopLossTicks = body.stopLossTicks ?? null;
  if (stopLossTicks !== null && !isFiniteInt(stopLossTicks, 1, 1_000_000_000)) {
    return { ok: false, message: 'stopLossTicks must be null or a positive integer' };
  }
  const takeProfitTicks = body.takeProfitTicks ?? null;
  if (takeProfitTicks !== null && !isFiniteInt(takeProfitTicks, 1, 1_000_000_000)) {
    return { ok: false, message: 'takeProfitTicks must be null or a positive integer' };
  }
  if (body.reduceOnly !== undefined && typeof body.reduceOnly !== 'boolean') {
    return { ok: false, message: 'reduceOnly must be a boolean' };
  }
  return {
    ok: true,
    value: {
      clientOrderId: body.clientOrderId,
      side: body.side,
      type: body.type,
      contracts: body.contracts,
      limitPriceTicks,
      stopLossTicks,
      takeProfitTicks,
      reduceOnly: Boolean(body.reduceOnly),
    },
  };
}

export interface SessionSettingsInput {
  strategyEnabled?: boolean;
  resetTimeZone?: string;
  riskLimits?: Partial<PaperRiskLimits>;
  activeVersion?: PaperParameterVersion;
  resetDailyLossHalt?: boolean;
  resetDrawdownHalt?: boolean;
  resetKillSwitch?: boolean;
  resetStaleSession?: boolean;
}

export function validateSessionSettingsInput(
  body: unknown,
): ValidationResult<SessionSettingsInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  if (body.strategyEnabled !== undefined && typeof body.strategyEnabled !== 'boolean') {
    return { ok: false, message: 'strategyEnabled must be a boolean' };
  }
  if (body.resetTimeZone !== undefined) {
    if (typeof body.resetTimeZone !== 'string' || !isValidTimeZone(body.resetTimeZone)) {
      return { ok: false, message: 'resetTimeZone must be a valid IANA timezone' };
    }
  }
  if (body.activeVersion !== undefined && !isValidParameterVersion(body.activeVersion)) {
    return { ok: false, message: 'Invalid activeVersion payload' };
  }
  return {
    ok: true,
    value: {
      strategyEnabled: body.strategyEnabled as boolean | undefined,
      resetTimeZone:
        typeof body.resetTimeZone === 'string' ? body.resetTimeZone.trim() : undefined,
      riskLimits: isPlainObject(body.riskLimits)
        ? (body.riskLimits as Partial<PaperRiskLimits>)
        : undefined,
      activeVersion: body.activeVersion as PaperParameterVersion | undefined,
      resetDailyLossHalt: body.resetDailyLossHalt === true,
      resetDrawdownHalt: body.resetDrawdownHalt === true,
      resetKillSwitch: body.resetKillSwitch === true,
      resetStaleSession: body.resetStaleSession === true,
    },
  };
}

function isValidParameterVersion(v: unknown): v is PaperParameterVersion {
  if (!isPlainObject(v)) return false;
  if (!isValidId(v.versionId)) return false;
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 80) return false;
  if (!isFiniteNum(v.createdAtSec)) return false;
  if (!isPlainObject(v.regimeOptions) || !isPlainObject(v.guardrailThresholds) || !isPlainObject(v.strategyParams)) {
    return false;
  }
  if (!isFiniteInt(v.baseSlippageTicks, 1, 50)) return false;
  if (!isFiniteInt(v.fixedHalfSpreadTicks, 1, 50)) return false;
  return true;
}

export function validateRestoreSnapshotInput(
  body: unknown,
  expectedSessionId: string,
  expectedUid: string,
): ValidationResult<PaperRestoreSnapshotPayload> {
  if (!isPlainObject(body)) return { ok: false, message: 'Restore payload must be an object' };
  const acct = body.account;
  if (!isPlainObject(acct)) return { ok: false, message: 'Restore payload missing account' };
  if (acct.sessionId !== expectedSessionId) {
    return { ok: false, message: 'account.sessionId does not match URL sessionId' };
  }
  if (acct.uid !== expectedUid) {
    return { ok: false, message: 'account.uid does not match authenticated user' };
  }
  if (typeof acct.symbol !== 'string' || !SYMBOL_RE.test(acct.symbol)) {
    return { ok: false, message: 'Invalid account.symbol' };
  }
  if (acct.resolution !== '15m' && acct.resolution !== '1h') {
    return { ok: false, message: 'Invalid account.resolution' };
  }
  const unitFields = [
    'startingBalanceUnits',
    'balanceUnits',
    'equityUnits',
    'realizedPnlUnits',
    'unrealizedPnlUnits',
    'marginUsedUnits',
    'peakEquityUnits',
    'dailyStartEquityUnits',
  ] as const;
  for (const field of unitFields) {
    if (!isUnitsString(acct[field])) {
      return { ok: false, message: `account.${field} must be a valid BigInt decimal string` };
    }
  }
  if (typeof acct.resetTimeZone !== 'string' || !isValidTimeZone(acct.resetTimeZone)) {
    return { ok: false, message: 'account.resetTimeZone must be a valid IANA timezone' };
  }
  if (!isFiniteInt(acct.sessionVersion, 1, 1_000_000_000)) {
    return { ok: false, message: 'account.sessionVersion must be a positive integer (>= 1)' };
  }
  if (!isPlainObject(body.contract) || typeof body.contract.symbol !== 'string') {
    return { ok: false, message: 'Restore payload missing valid contract' };
  }
  if (
    body.contract.rateExchangeIntervalSource !== undefined &&
    body.contract.rateExchangeIntervalSource !== 'api' &&
    body.contract.rateExchangeIntervalSource !== 'fallback_28800s'
  ) {
    return {
      ok: false,
      message: 'Restore payload contract.rateExchangeIntervalSource must be "api" or "fallback_28800s"',
    };
  }
  if (!isValidParameterVersion(body.activeVersion)) {
    return { ok: false, message: 'Restore payload missing valid activeVersion' };
  }
  const arrayFields = [
    'versions',
    'openOrders',
    'openPositions',
    'recentFills',
    'closedTrades',
    'heldOutLogs',
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(body[field]) || (body[field] as unknown[]).length > 1000) {
      return { ok: false, message: `Restore payload.${field} must be an array (<= 1000 items)` };
    }
  }

  return {
    ok: true,
    value: {
      account: acct as unknown as PaperAccount,
      contract: body.contract as unknown as PaperContractSpec,
      activeVersion: body.activeVersion,
      versions: body.versions as PaperParameterVersion[],
      openOrders: body.openOrders as PaperOrder[],
      openPositions: body.openPositions as PaperPosition[],
      recentFills: body.recentFills as PaperFill[],
      closedTrades: body.closedTrades as PaperClosedTrade[],
      heldOutLogs: body.heldOutLogs as HeldOutEvaluationLog[],
    },
  };
}

export interface WalkForwardInput {
  fixedHalfSpreadTicks: number;
  lookbackBars: number;
}

export function validateWalkForwardInput(body: unknown): ValidationResult<WalkForwardInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  const fixedHalfSpreadTicks =
    body.fixedHalfSpreadTicks === undefined ? 2 : Number(body.fixedHalfSpreadTicks);
  if (!isFiniteInt(fixedHalfSpreadTicks, 1, 50)) {
    return { ok: false, message: 'fixedHalfSpreadTicks must be an integer between 1 and 50' };
  }
  const lookbackBars = body.lookbackBars === undefined ? 800 : Number(body.lookbackBars);
  if (!isFiniteInt(lookbackBars, 240, 2400)) {
    return { ok: false, message: 'lookbackBars must be an integer between 240 and 2400' };
  }
  return { ok: true, value: { fixedHalfSpreadTicks, lookbackBars } };
}

export interface HeldOutEvalInput {
  version: PaperParameterVersion;
  lookbackBars: number;
}

export function validateHeldOutEvalInput(body: unknown): ValidationResult<HeldOutEvalInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  if (!isValidParameterVersion(body.version)) {
    return { ok: false, message: 'Invalid parameter version object' };
  }
  const lookbackBars = body.lookbackBars === undefined ? 800 : Number(body.lookbackBars);
  if (!isFiniteInt(lookbackBars, 240, 2400)) {
    return { ok: false, message: 'lookbackBars must be an integer between 240 and 2400' };
  }
  return { ok: true, value: { version: body.version, lookbackBars } };
}

export function validateExplainClosedTradeInput(
  body: unknown,
): ValidationResult<ExplainClosedTradeRequest> {
  if (!isPlainObject(body)) return { ok: false, message: 'Body must be a JSON object' };
  if (!isPlainObject(body.trade) || !isPlainObject(body.contract)) {
    return { ok: false, message: 'Expected { trade, contract } payload' };
  }
  const t = body.trade;
  if (!isValidId(t.tradeId) || (t.side !== 'LONG' && t.side !== 'SHORT')) {
    return { ok: false, message: 'Invalid tradeId or side' };
  }
  if (!isFiniteInt(t.contracts, 1, 100_000)) {
    return { ok: false, message: 'Invalid trade.contracts' };
  }
  if (
    !isUnitsString(t.grossPnlUnits) ||
    !isUnitsString(t.totalFeesUnits) ||
    !isUnitsString(t.totalSlippageUnits) ||
    !isUnitsString(t.fundingPnlUnits) ||
    !isUnitsString(t.liquidationPenaltyUnits) ||
    !isUnitsString(t.netPnlUnits)
  ) {
    return { ok: false, message: 'Trade PnL/cost fields must be valid BigInt unit strings' };
  }
  if (
    typeof body.contract.symbol !== 'string' ||
    typeof body.contract.tickSizeStr !== 'string' ||
    typeof body.contract.contractValueStr !== 'string'
  ) {
    return { ok: false, message: 'Invalid contract spec fields' };
  }
  return {
    ok: true,
    value: body as unknown as ExplainClosedTradeRequest,
  };
}
