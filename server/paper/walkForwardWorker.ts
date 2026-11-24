import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type {
  PaperContractSpec,
  PaperParameterVersion,
  PaperRiskLimits,
} from '../../src/contracts/paper.ts';
import type { CandlePoint } from '../../src/engine/regime.ts';
import { runFocusedWalkForwardSearch } from '../../src/engine/paperAnalytics.ts';

export interface WalkForwardWorkerPayload {
  kind: 'WALK_FORWARD';
  contract: PaperContractSpec;
  resolution: '15m' | '1h';
  baseVersion: PaperParameterVersion;
  tradeCandles: CandlePoint[];
  markCandles: CandlePoint[];
  fixedHalfSpreadTicks: number;
  riskLimits?: Partial<PaperRiskLimits>;
  nowSec: number;
}

export function executeWalkForwardTaskIfWorker(): boolean {
  if (isMainThread) return false;
  const data = workerData as Partial<WalkForwardWorkerPayload> | null;
  if (!data || data.kind !== 'WALK_FORWARD') return false;

  try {
    const report = runFocusedWalkForwardSearch({
      contract: data.contract!,
      resolution: data.resolution!,
      baseVersion: data.baseVersion!,
      tradeCandles: data.tradeCandles!,
      markCandles: data.markCandles!,
      fixedHalfSpreadTicks: data.fixedHalfSpreadTicks!,
      riskLimits: data.riskLimits,
      nowSec: data.nowSec!,
    });
    parentPort?.postMessage({ ok: true, report });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : 'Walk-forward worker failed',
    });
  }
  return true;
}

if (!isMainThread) {
  executeWalkForwardTaskIfWorker();
}
