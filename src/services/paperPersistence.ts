import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import type {
  HeldOutEvaluationLog,
  PaperAccount,
  PaperClosedTrade,
  PaperContractSpec,
  PaperFill,
  PaperOrder,
  PaperParameterVersion,
  PaperPosition,
  PaperRestoreSnapshotPayload,
  PaperSessionState,
} from '../contracts/paper';
import {
  db,
  extractFirestoreErrorCode,
  handleFirestoreError,
  OperationType,
} from '../firebase';

const LEDGER_ROOT = ['paper', 'ledger'] as const;
const THROTTLED_SNAPSHOT_INTERVAL_MS = 60_000;

const lastAccountSyncAtMs = new Map<string, number>();
const persistedImmutableIds = new Set<string>();

function ledgerPath(uid: string, subcol: string, docId?: string): string {
  return docId
    ? `users/${uid}/${LEDGER_ROOT[0]}/${LEDGER_ROOT[1]}/${subcol}/${docId}`
    : `users/${uid}/${LEDGER_ROOT[0]}/${LEDGER_ROOT[1]}/${subcol}`;
}

function ledgerCol(uid: string, subcol: string) {
  if (!db) throw new Error('Firestore is not configured');
  return collection(db, 'users', uid, LEDGER_ROOT[0], LEDGER_ROOT[1], subcol);
}

function ledgerDoc(uid: string, subcol: string, docId: string) {
  if (!db) throw new Error('Firestore is not configured');
  return doc(db, 'users', uid, LEDGER_ROOT[0], LEDGER_ROOT[1], subcol, docId);
}

function isIdempotentAlreadyExists(err: unknown): boolean {
  const code = extractFirestoreErrorCode(err);
  return code === 'already-exists';
}

async function createImmutableDocIfAbsent(
  uid: string,
  subcol: 'fills' | 'trades' | 'versions' | 'heldOutLogs',
  docId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const cacheKey = `${uid}:${subcol}:${docId}`;
  if (persistedImmutableIds.has(cacheKey)) return;

  const path = ledgerPath(uid, subcol, docId);
  const ref = ledgerDoc(uid, subcol, docId);

  let existing;
  try {
    existing = await getDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (existing.exists()) {
    persistedImmutableIds.add(cacheKey);
    return;
  }

  try {
    await setDoc(ref, {
      ...payload,
      serverWrittenAt: serverTimestamp(),
    });
    persistedImmutableIds.add(cacheKey);
  } catch (err) {
    if (isIdempotentAlreadyExists(err)) {
      persistedImmutableIds.add(cacheKey);
      return;
    }
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

/**
 * Quota-conscious Firestore sync:
 * - Never writes per-tick mark_price updates.
 * - Writes account & open positions strictly on lifecycle events OR at most once per 60s.
 * - Immutable collections (fills, trades, versions, heldOutLogs) use deterministic IDs
 *   and treat already-exists as idempotent success.
 */
export async function syncPaperStateToFirestore(
  uid: string,
  state: PaperSessionState,
  options: { forceEventWrite?: boolean } = {},
): Promise<void> {
  if (!db) return;

  const nowMs = Date.now();
  const lastWrite = lastAccountSyncAtMs.get(state.account.sessionId) ?? 0;
  const shouldWriteAccount =
    Boolean(options.forceEventWrite) || nowMs - lastWrite >= THROTTLED_SNAPSHOT_INTERVAL_MS;

  if (!shouldWriteAccount) {
    return;
  }

  lastAccountSyncAtMs.set(state.account.sessionId, nowMs);

  // 1. Account snapshot doc (includes contract, activeVersion, riskLimits for clean restore)
  const accountPath = ledgerPath(uid, 'accounts', state.account.sessionId);
  try {
    await setDoc(ledgerDoc(uid, 'accounts', state.account.sessionId), {
      ...state.account,
      contract: state.contract,
      activeVersion: state.activeVersion,
      serverWrittenAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, accountPath);
  }

  // 2. Open positions & remove closed position docs
  const positionsPath = ledgerPath(uid, 'positions');
  let existingPosSnap;
  try {
    existingPosSnap = await getDocs(
      query(ledgerCol(uid, 'positions'), where('sessionId', '==', state.account.sessionId)),
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, positionsPath);
  }
  const currentPosIds = new Set(state.openPositions.map((p) => p.positionId));
  for (const snap of existingPosSnap.docs) {
    if (!currentPosIds.has(snap.id)) {
      try {
        await deleteDoc(snap.ref);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, ledgerPath(uid, 'positions', snap.id));
      }
    }
  }
  for (const pos of state.openPositions) {
    try {
      await setDoc(ledgerDoc(uid, 'positions', pos.positionId), {
        ...pos,
        serverWrittenAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, ledgerPath(uid, 'positions', pos.positionId));
    }
  }

  // 3. Open orders (and remove stale filled/cancelled open order docs on event)
  const ordersPath = ledgerPath(uid, 'orders');
  let existingOrderSnap;
  try {
    existingOrderSnap = await getDocs(
      query(ledgerCol(uid, 'orders'), where('sessionId', '==', state.account.sessionId)),
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, ordersPath);
  }
  const currentOrderIds = new Set(state.openOrders.map((o) => o.clientOrderId));
  for (const snap of existingOrderSnap.docs) {
    if (!currentOrderIds.has(snap.id)) {
      try {
        await deleteDoc(snap.ref);
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, ledgerPath(uid, 'orders', snap.id));
      }
    }
  }
  for (const ord of state.openOrders) {
    try {
      await setDoc(ledgerDoc(uid, 'orders', ord.clientOrderId), {
        ...ord,
        serverWrittenAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, ledgerPath(uid, 'orders', ord.clientOrderId));
    }
  }

  // 4. Immutable versions, fills, closedTrades, heldOutLogs
  for (const v of state.versions) {
    await createImmutableDocIfAbsent(uid, 'versions', v.versionId, { ...v });
  }
  for (const f of state.recentFills) {
    await createImmutableDocIfAbsent(uid, 'fills', f.fillId, { ...f });
  }
  for (const t of state.closedTrades) {
    await createImmutableDocIfAbsent(uid, 'trades', t.tradeId, { ...t });
  }
  for (const log of state.heldOutLogs) {
    await createImmutableDocIfAbsent(uid, 'heldOutLogs', log.logId, { ...log });
  }
}

export async function recordSubmittedOrderToFirestore(
  uid: string,
  order: PaperOrder,
): Promise<void> {
  if (!db) return;
  const path = ledgerPath(uid, 'orders', order.clientOrderId);
  try {
    await setDoc(ledgerDoc(uid, 'orders', order.clientOrderId), {
      ...order,
      serverWrittenAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function loadSavedPaperSnapshotsFromFirestore(
  uid: string,
): Promise<PaperRestoreSnapshotPayload[]> {
  if (!db) return [];

  let acctSnap;
  try {
    acctSnap = await getDocs(ledgerCol(uid, 'accounts'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, ledgerPath(uid, 'accounts'));
  }
  if (acctSnap.empty) return [];

  let ordersSnap;
  let fillsSnap;
  let posSnap;
  let tradesSnap;
  let versionsSnap;
  let heldOutSnap;
  try {
    [ordersSnap, fillsSnap, posSnap, tradesSnap, versionsSnap, heldOutSnap] = await Promise.all([
      getDocs(ledgerCol(uid, 'orders')),
      getDocs(ledgerCol(uid, 'fills')),
      getDocs(ledgerCol(uid, 'positions')),
      getDocs(ledgerCol(uid, 'trades')),
      getDocs(ledgerCol(uid, 'versions')),
      getDocs(ledgerCol(uid, 'heldOutLogs')),
    ]);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `users/${uid}/${LEDGER_ROOT[0]}/${LEDGER_ROOT[1]}`);
  }

  const versionsById = new Map<string, PaperParameterVersion>();
  for (const d of versionsSnap.docs) {
    persistedImmutableIds.add(`${uid}:versions:${d.id}`);
    versionsById.set(d.id, d.data() as PaperParameterVersion);
  }
  for (const d of fillsSnap.docs) persistedImmutableIds.add(`${uid}:fills:${d.id}`);
  for (const d of tradesSnap.docs) persistedImmutableIds.add(`${uid}:trades:${d.id}`);
  for (const d of heldOutSnap.docs) persistedImmutableIds.add(`${uid}:heldOutLogs:${d.id}`);

  const snapshots: PaperRestoreSnapshotPayload[] = [];
  for (const d of acctSnap.docs) {
    const raw = d.data() as PaperAccount & {
      contract?: PaperContractSpec;
      activeVersion?: PaperParameterVersion;
    };
    if (!raw.contract || !raw.activeVersion) continue;

    const sessionId = raw.sessionId;
    const heldOutLogs = heldOutSnap.docs
      .map((x) => x.data() as HeldOutEvaluationLog)
      .filter((l) => l.sessionId === sessionId)
      .sort((a, b) => b.inspectionIndex - a.inspectionIndex);

    const account: PaperAccount = {
      sessionId: raw.sessionId,
      uid: raw.uid,
      symbol: raw.symbol,
      resolution: raw.resolution,
      startingBalanceUnits: raw.startingBalanceUnits,
      balanceUnits: raw.balanceUnits,
      equityUnits: raw.equityUnits,
      realizedPnlUnits: raw.realizedPnlUnits,
      unrealizedPnlUnits: raw.unrealizedPnlUnits,
      marginUsedUnits: raw.marginUsedUnits,
      peakEquityUnits: raw.peakEquityUnits,
      dailyStartEquityUnits: raw.dailyStartEquityUnits,
      currentDayKey: raw.currentDayKey,
      resetTimeZone: raw.resetTimeZone,
      riskLimits: raw.riskLimits,
      parameterVersionId: raw.parameterVersionId,
      strategyEnabled: raw.strategyEnabled,
      dailyLossHalted: raw.dailyLossHalted,
      drawdownHalted: raw.drawdownHalted,
      killSwitchActive: raw.killSwitchActive,
      stale: raw.stale,
      staleReason: raw.staleReason ?? null,
      lastProcessedCandleTime: raw.lastProcessedCandleTime ?? null,
      lastFundingTime: raw.lastFundingTime ?? null,
      lastMarkPriceTicks: raw.lastMarkPriceTicks ?? null,
      heldOutInspectionCount: heldOutLogs.length,
      sessionVersion:
        typeof raw.sessionVersion === 'number' &&
        Number.isInteger(raw.sessionVersion) &&
        raw.sessionVersion >= 1
          ? raw.sessionVersion
          : 1,
      createdAtSec: raw.createdAtSec,
      updatedAtSec: raw.updatedAtSec,
    };

    const openOrders = ordersSnap.docs
      .map((x) => x.data() as PaperOrder)
      .filter((o) => o.sessionId === sessionId && o.status === 'OPEN');
    const openPositions = posSnap.docs
      .map((x) => x.data() as PaperPosition)
      .filter((p) => p.sessionId === sessionId);
    const recentFills = fillsSnap.docs
      .map((x) => x.data() as PaperFill)
      .filter((f) => f.sessionId === sessionId)
      .sort((a, b) => b.executedAtSec - a.executedAtSec);
    const closedTrades = tradesSnap.docs
      .map((x) => x.data() as PaperClosedTrade)
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => b.closedAtSec - a.closedAtSec);

    snapshots.push({
      account,
      contract: {
        ...raw.contract,
        rateExchangeIntervalSource: raw.contract.rateExchangeIntervalSource ?? 'api',
      },
      activeVersion: raw.activeVersion,
      versions: Array.from(versionsById.values()),
      openOrders,
      openPositions,
      recentFills,
      closedTrades,
      heldOutLogs,
    });
  }

  return snapshots.sort((a, b) => b.account.updatedAtSec - a.account.updatedAtSec);
}

export async function deleteSavedPaperSessionFromFirestore(
  uid: string,
  sessionId: string,
): Promise<void> {
  if (!db) return;
  try {
    await deleteDoc(ledgerDoc(uid, 'accounts', sessionId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, ledgerPath(uid, 'accounts', sessionId));
  }

  let posSnap;
  let ordSnap;
  try {
    [posSnap, ordSnap] = await Promise.all([
      getDocs(query(ledgerCol(uid, 'positions'), where('sessionId', '==', sessionId))),
      getDocs(query(ledgerCol(uid, 'orders'), where('sessionId', '==', sessionId))),
    ]);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `users/${uid}/${LEDGER_ROOT[0]}/${LEDGER_ROOT[1]}`);
  }

  try {
    await Promise.all([
      ...posSnap.docs.map((s) => deleteDoc(s.ref)),
      ...ordSnap.docs.map((s) => deleteDoc(s.ref)),
    ]);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `users/${uid}/${LEDGER_ROOT[0]}/${LEDGER_ROOT[1]}`);
  }
}
