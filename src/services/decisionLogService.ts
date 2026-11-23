import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { GuardrailDecision, GuardrailEvaluation, GuardrailThresholds } from '../engine/guardrails';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  sanitizeDecisionPayload,
  type DecisionSource,
  type LogDecisionPayload,
} from './decisionPayload';

export { sanitizeDecisionPayload, type DecisionSource, type LogDecisionPayload };

export interface DecisionLogRecord {
  id: string;
  timestampIso: string | null;
  source: DecisionSource;
  symbol: string;
  timeframe: string;
  decision: GuardrailDecision;
  firedRules: string[];
  reasons: string[];
  inputs: GuardrailEvaluation['inputs'];
  thresholdsUsed: GuardrailThresholds;
  lastCandleTime: number | null;
  candleCount: number;
}

function getDecisionsPath(uid: string): string {
  return `users/${uid}/decisions`;
}

function parseDecisionDoc(snapshot: QueryDocumentSnapshot): DecisionLogRecord {
  const data = snapshot.data();
  const rawTimestamp = data.timestamp;
  let timestampIso: string | null = null;
  if (rawTimestamp instanceof Timestamp) {
    timestampIso = rawTimestamp.toDate().toISOString();
  } else if (
    rawTimestamp &&
    typeof rawTimestamp === 'object' &&
    'toDate' in rawTimestamp &&
    typeof (rawTimestamp as { toDate: () => Date }).toDate === 'function'
  ) {
    timestampIso = (rawTimestamp as { toDate: () => Date }).toDate().toISOString();
  }

  return {
    id: snapshot.id,
    timestampIso,
    source: data.source === 'Alpaca' ? 'Alpaca' : 'Delta',
    symbol: typeof data.symbol === 'string' ? data.symbol : '—',
    timeframe: typeof data.timeframe === 'string' ? data.timeframe : '—',
    decision:
      data.decision === 'CONTINUE' ||
      data.decision === 'REDUCE_SIZE' ||
      data.decision === 'PAUSE' ||
      data.decision === 'NO_DECISION'
        ? data.decision
        : 'NO_DECISION',
    firedRules: Array.isArray(data.firedRules)
      ? data.firedRules.filter((x): x is string => typeof x === 'string')
      : [],
    reasons: Array.isArray(data.reasons)
      ? data.reasons.filter((x): x is string => typeof x === 'string')
      : [],
    inputs:
      data.inputs && typeof data.inputs === 'object'
        ? (data.inputs as GuardrailEvaluation['inputs'])
        : {
            score: null,
            volZ: null,
            trend: null,
            changePointsInWindow: 0,
            lastChangePointAgeBars: null,
          },
    thresholdsUsed: data.thresholdsUsed as GuardrailThresholds,
    lastCandleTime: typeof data.lastCandleTime === 'number' ? data.lastCandleTime : null,
    candleCount: typeof data.candleCount === 'number' ? data.candleCount : 0,
  };
}

export async function logGuardrailDecision(
  uid: string,
  payload: LogDecisionPayload,
): Promise<string> {
  if (!db) {
    throw new Error('Firestore is not configured.');
  }
  const path = getDecisionsPath(uid);
  const sanitizedDoc = {
    timestamp: serverTimestamp(),
    ...sanitizeDecisionPayload(payload),
  };

  try {
    const ref = await addDoc(collection(db, 'users', uid, 'decisions'), sanitizedDoc);
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeToDecisionLog(
  uid: string,
  onRecords: (records: DecisionLogRecord[]) => void,
  onError: (err: Error) => void,
): () => void {
  if (!db) {
    onError(new Error('Firestore is not configured.'));
    return () => {};
  }
  const path = getDecisionsPath(uid);
  const q = query(
    collection(db, 'users', uid, 'decisions'),
    orderBy('timestamp', 'desc'),
    limit(50),
  );

  return onSnapshot(
    q,
    (snap) => {
      onRecords(snap.docs.map(parseDecisionDoc));
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export async function fetchDecisionLog(uid: string): Promise<DecisionLogRecord[]> {
  if (!db) {
    throw new Error('Firestore is not configured.');
  }
  const path = getDecisionsPath(uid);
  const q = query(
    collection(db, 'users', uid, 'decisions'),
    orderBy('timestamp', 'desc'),
    limit(50),
  );

  try {
    const snap = await getDocs(q);
    return snap.docs.map(parseDecisionDoc);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function deleteDecisionLogEntry(uid: string, docId: string): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not configured.');
  }
  const path = `${getDecisionsPath(uid)}/${docId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'decisions', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
