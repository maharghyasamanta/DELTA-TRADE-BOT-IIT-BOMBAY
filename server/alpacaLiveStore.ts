import type {
  PaperSessionState,
  PaperStrategyParams,
  PaperPositionSide,
  PaperGuardrailSnapshot,
  PaperSignalSnapshot,
} from '../src/contracts/paper.ts';
import {
  computeGuardrailSnapshotForCandles,
  createDefaultParameterVersion,
  getPaperStrategy,
  type StrategyDecision,
  type PaperStrategyContext,
} from '../src/engine/paperStrategy.ts';
import type { CandlePoint } from '../src/engine/regime.ts';
import { DELTA_RESOLUTION_SECONDS } from './deltaClient.ts';
import {
  fetchPaginatedDeltaCandles,
} from './paper/paperRunner.ts';
import {
  ALPACA_TRADING_CONFIGURED,
  getAlpacaAccount,
  getAlpacaPositions,
  placeAlpacaOrder,
  cancelAlpacaOrder,
  closeAllAlpacaPositions,
  alpacaSideToPositionSide,
  positionSideToAlpacaSide,
  formatAlpacaPrice,
} from './alpacaTrading.ts';
import { queryBrainDecision, BRAIN_CONFIGURED } from './brainClient.ts';

export interface LiveDecisionResult {
  decision: StrategyDecision;
  executed: boolean;
  orderId?: string;
  reason: string;
}

/**
 * LiveTradingStore: Bridges the Brain (DeepSeek-R1) to real Alpaca Paper Trading.
 * Fully automated — executes decisions without user intervention when enabled.
 */
export class LiveTradingStore {
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private currentSymbol = 'SPY';
  private currentState: PaperSessionState | null = null;

  constructor() {
    // Initialize an internal state mirror for tracking
    this.currentState = this.createDefaultState();
  }

  private createDefaultState(): PaperSessionState {
    const now = Math.floor(Date.now() / 1000);
    return {
      account: {
        sessionId: 'live_session_default',
        uid: 'automated',
        symbol: this.currentSymbol,
        resolution: '1h',
        startingBalanceUnits: '1000000000000', // placeholder
        balanceUnits: '1000000000000',
        equityUnits: '1000000000000',
        realizedPnlUnits: '0',
        unrealizedPnlUnits: '0',
        marginUsedUnits: '0',
        peakEquityUnits: '1000000000000',
        dailyStartEquityUnits: '1000000000000',
        currentDayKey: new Date().toISOString().split('T')[0],
        resetTimeZone: 'UTC',
        riskLimits: {
          maxRiskPerTradeBps: 100,
          maxOpenPositions: 5,
          maxDailyLossBps: 500,
          maxDrawdownBps: 1500,
          maxLeverage: 2,
        },
        parameterVersionId: 'brain_v1',
        strategyEnabled: true,
        dailyLossHalted: false,
        drawdownHalted: false,
        killSwitchActive: false,
        stale: false,
        staleReason: null,
        lastProcessedCandleTime: null,
        lastFundingTime: now,
        lastMarkPriceTicks: null,
        heldOutInspectionCount: 0,
        sessionVersion: 1,
        createdAtSec: now,
        updatedAtSec: now,
      },
      contract: {
        symbol: this.currentSymbol,
        productId: 0,
        tickSizeStr: '0.01',
        tickSizeUnits: '1000000',
        contractValueStr: '1',
        contractValueUnits: '100000000',
        makerCommissionRateStr: '0',
        makerRateUnits: '0',
        takerCommissionRateStr: '0',
        takerRateUnits: '0',
        initialMarginStr: '0',
        initialMarginRateUnits: '0',
        initialMarginScalingFactorStr: '0',
        initialMarginScalingUnits: '0',
        maintenanceMarginStr: '0',
        maintenanceMarginRateUnits: '0',
        maintenanceMarginScalingFactorStr: '0',
        maintenanceMarginScalingUnits: '0',
        liquidationPenaltyFactorStr: '0',
        liquidationPenaltyFactorUnits: '0',
        defaultLeverage: 2,
        rateExchangeIntervalSec: 86400,
        rateExchangeIntervalSource: 'api',
      },
      activeVersion: createDefaultParameterVersion(),
      versions: [createDefaultParameterVersion()],
      openOrders: [],
      openPositions: [],
      recentFills: [],
      closedTrades: [],
      equityCurve: [{ time: now, equity: 10000, equityUnits: '1000000000000' }],
      heldOutLogs: [],
    };
  }

  async startAutomation(symbol: string = 'SPY'): Promise<void> {
    if (!ALPACA_TRADING_CONFIGURED) {
      throw new Error('Alpaca Trading not configured. Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY.');
    }
    if (!BRAIN_CONFIGURED) {
      throw new Error('Brain not configured. Set BRAIN_API_KEY.');
    }

    this.currentSymbol = symbol;
    this.isRunning = true;

    console.log(`[LiveTradingStore] Starting automated trading for ${symbol}`);

    // Run immediately, then every 5 minutes
    await this.processCycle();

    this.pollingInterval = setInterval(async () => {
      try {
        await this.processCycle();
      } catch (err) {
        console.error('[LiveTradingStore] Cycle error:', err);
      }
    }, 5 * 60 * 1000);
  }

  stopAutomation(): void {
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('[LiveTradingStore] Automation stopped');
  }

  async processCycle(): Promise<LiveDecisionResult> {
    try {
      // 1. Sync Alpaca account state
      const [account, positions] = await Promise.all([
        getAlpacaAccount(),
        getAlpacaPositions(),
      ]);

      console.log(`[LiveTradingStore] Account Equity: $${account.equity}, Positions: ${positions.length}`);

      // 2. Fetch recent candles for regime analysis
      const now = Math.floor(Date.now() / 1000);
      const candles = await fetchPaginatedDeltaCandles({
        symbol: this.currentSymbol,
        resolution: '1h',
        barCount: 200,
        endSec: now,
        basis: 'trade',
      });

      // 3. Build strategy context
      const tickSizeNum = 0.01;
      const { signal, guardrail } = computeGuardrailSnapshotForCandles(
        candles,
        this.currentState!.activeVersion,
        tickSizeNum,
      );

      // Find current position for this symbol
      const alpacaPos = positions.find((p) => p.symbol === this.currentSymbol);
      const currentPosition = alpacaPos ? {
        positionId: `alpaca_${alpacaPos.symbol}`,
        sessionId: 'live_session_default',
        symbol: alpacaPos.symbol,
        side: alpacaSideToPositionSide(alpacaPos.side),
        contracts: parseFloat(alpacaPos.qty),
        entryPriceTicks: Math.round(parseFloat(alpacaPos.avg_entry_price) / tickSizeNum),
        markPriceTicks: Math.round(parseFloat(alpacaPos.current_price) / tickSizeNum),
        liquidationPriceTicks: 0,
        allocatedMarginUnits: '0',
        maintenanceMarginUnits: '0',
        unrealizedPnlUnits: '0',
        accruedFundingUnits: '0',
        entryFeesUnits: '0',
        entrySlippageUnits: '0',
        stopLossTicks: null,
        takeProfitTicks: null,
        parameterVersionId: 'brain_v1',
        entryGuardrail: guardrail,
        openedAtSec: Date.now(),
        updatedAtSec: Date.now(),
      } : null;

      const ctx: PaperStrategyContext = {
        closedCandles: candles,
        signal,
        guardrail,
        currentPosition,
        tickSizeNum,
        params: {
          strategyId: 'brain_auto',
          trendEntryThreshold: 0.2,
          stopVolMultiplier: 2.0,
          targetVolMultiplier: 3.0,
          defaultSizeFractionBps: 10000,
        },
      };

      // 4. Query the Brain for a decision
      const brainDecision = await queryBrainDecision(ctx);
      console.log(`[LiveTradingStore] Brain Decision: ${brainDecision.action} - ${brainDecision.reason}`);

      // 5. Execute the decision via Alpaca
      let executed = false;
      let orderId: string | undefined;

      if (brainDecision.action === 'LONG' || brainDecision.action === 'SHORT') {
        const side = positionSideToAlpacaSide(brainDecision.action as PaperPositionSide);
        const qty = 1; // Start with 1 share — can be sized by risk later

        // If we have an opposite position, close it first
        if (currentPosition && currentPosition.side !== brainDecision.action) {
          await placeAlpacaOrder({
            symbol: this.currentSymbol,
            qty: Math.abs(currentPosition.contracts),
            side: positionSideToAlpacaSide(currentPosition.side),
            type: 'market',
            time_in_force: 'day',
          });
        }

        const order = await placeAlpacaOrder({
          symbol: this.currentSymbol,
          qty,
          side,
          type: 'market',
          time_in_force: 'day',
        });

        executed = true;
        orderId = order.id;
      } else if (brainDecision.action === 'FLAT' && currentPosition) {
        // Close position
        await placeAlpacaOrder({
          symbol: this.currentSymbol,
          qty: Math.abs(currentPosition.contracts),
          side: positionSideToAlpacaSide(currentPosition.side),
          type: 'market',
          time_in_force: 'day',
        });

        executed = true;
        orderId = 'flat_all';
      }

      return {
        decision: brainDecision,
        executed,
        orderId,
        reason: brainDecision.reason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveTradingStore] Process cycle failed:', message);
      return {
        decision: {
          action: 'HOLD',
          desiredSizeFractionBps: 0,
          stopLossOffsetTicks: null,
          takeProfitOffsetTicks: null,
          reason: message,
        },
        executed: false,
        reason: message,
      };
    }
  }

  async emergencyFlatten(): Promise<void> {
    if (!ALPACA_TRADING_CONFIGURED) return;
    await closeAllAlpacaPositions();
    console.log('[LiveTradingStore] Emergency flatten executed');
  }

  getStatus() {
    return {
      running: this.isRunning,
      symbol: this.currentSymbol,
      alpacaConfigured: ALPACA_TRADING_CONFIGURED,
      brainConfigured: BRAIN_CONFIGURED,
    };
  }
}

export const liveTradingStore = new LiveTradingStore();
