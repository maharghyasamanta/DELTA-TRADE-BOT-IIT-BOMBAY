import { Worker } from 'node:worker_threads';
import {
  DELTA_RESOLUTION_SECONDS,
  fetchCandlesHistory,
} from '../deltaClient.ts';
import type {
  PaperContractSpec,
  PaperParameterVersion,
  PaperRiskLimits,
  WalkForwardReport,
} from '../../src/contracts/paper.ts';
import type { CandlePoint } from '../../src/engine/regime.ts';
import type { WalkForwardWorkerPayload } from './walkForwardWorker.ts';

const ACTIVE_SEARCH_BY_UID = new Set<string>();
const MAX_CANDLES_PER_DELTA_REQ = 1500;
const WORKER_TIMEOUT_MS = 30_000;

export class PaperRunnerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 409, code = 'SEARCH_BUSY') {
    super(message);
    this.name = 'PaperRunnerError';
    this.status = status;
    this.code = code;
  }
}

export async function fetchPaginatedDeltaCandles(params: {
  symbol: string;
  resolution: '15m' | '1h';
  barCount: number;
  endSec: number;
  basis: 'trade' | 'mark';
}): Promise<CandlePoint[]> {
  const stepSec = DELTA_RESOLUTION_SECONDS[params.resolution];
  const alignedEnd = Math.floor(params.endSec / stepSec) * stepSec;
  const totalBars = Math.min(2400, Math.max(60, Math.floor(params.barCount)));
  const byTime = new Map<number, CandlePoint>();

  let cursorEnd = alignedEnd;
  let remaining = totalBars;
  let safetyBatches = 0;

  while (remaining > 0 && safetyBatches < 4) {
    safetyBatches += 1;
    const batchBars = Math.min(remaining, MAX_CANDLES_PER_DELTA_REQ);
    const batchStart = cursorEnd - batchBars * stepSec;

    const { payload } = await fetchCandlesHistory({
      symbol: params.symbol,
      resolution: params.resolution,
      start: batchStart,
      end: cursorEnd,
      basis: params.basis,
    });

    for (const c of payload.candles) {
      byTime.set(c.time, {
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }

    remaining -= batchBars;
    cursorEnd = batchStart - stepSec;
  }

  return Array.from(byTime.values())
    .sort((a, b) => a.time - b.time)
    .slice(-totalBars);
}

export function isWalkForwardBusyForUser(uid: string): boolean {
  return ACTIVE_SEARCH_BY_UID.has(uid);
}

export async function runWalkForwardInWorker(params: {
  uid: string;
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  baseVersion: PaperParameterVersion;
  tradeCandles: CandlePoint[];
  markCandles: CandlePoint[];
  fixedHalfSpreadTicks: number;
  riskLimits?: Partial<PaperRiskLimits>;
  nowSec: number;
}): Promise<WalkForwardReport> {
  const { uid } = params;
  if (ACTIVE_SEARCH_BY_UID.has(uid)) {
    throw new PaperRunnerError(
      'Another walk-forward search is already running for your account (max 1 concurrent search).',
      429,
      'WALK_FORWARD_BUSY',
    );
  }

  ACTIVE_SEARCH_BY_UID.add(uid);
  try {
    const workerData: WalkForwardWorkerPayload = {
      kind: 'WALK_FORWARD',
      contract: params.contract,
      resolution: params.resolution,
      baseVersion: params.baseVersion,
      tradeCandles: params.tradeCandles,
      markCandles: params.markCandles,
      fixedHalfSpreadTicks: params.fixedHalfSpreadTicks,
      riskLimits: params.riskLimits,
      nowSec: params.nowSec,
    };

    const isTsRuntime = import.meta.url.endsWith('.ts');
    const workerUrl = isTsRuntime
      ? new URL('./walkForwardWorker.ts', import.meta.url)
      : new URL(import.meta.url);

    return await new Promise<WalkForwardReport>((resolve, reject) => {
      const worker = new Worker(workerUrl, {
        workerData,
        ...(isTsRuntime ? { execArgv: process.execArgv } : {}),
      });

      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new PaperRunnerError('Walk-forward worker timed out after 30s', 504, 'WORKER_TIMEOUT'));
      }, WORKER_TIMEOUT_MS);

      worker.once('message', (msg: { ok?: boolean; report?: WalkForwardReport; error?: string }) => {
        clearTimeout(timer);
        if (msg?.ok && msg.report) {
          resolve(msg.report);
        } else {
          reject(
            new PaperRunnerError(
              msg?.error || 'Walk-forward worker failed',
              500,
              'WORKER_FAILED',
            ),
          );
        }
      });

      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(new PaperRunnerError(err.message || 'Worker thread error', 500, 'WORKER_ERROR'));
      });

      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new PaperRunnerError(`Walk-forward worker exited with code ${code}`, 500, 'WORKER_EXIT'));
        }
      });
    });
  } finally {
    ACTIVE_SEARCH_BY_UID.delete(uid);
  }
}
