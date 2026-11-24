import type {
  ExplainClosedTradeRequest,
  ExplainClosedTradeResponse,
  HeldOutEvaluationLog,
  PaperAccount,
  PaperClosedTrade,
  PaperDriftReport,
  PaperFill,
  PaperOrder,
  PaperParameterVersion,
  PaperRestoreSnapshotPayload,
  PaperRiskLimits,
  PaperSessionState,
  PaperTradeAnalytics,
  WalkForwardReport,
  WalkForwardSplitSummary,
} from '../contracts/paper';

export class PaperApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = 'PAPER_API_ERROR') {
    super(message);
    this.name = 'PaperApiError';
    this.status = status;
    this.code = code;
  }
}

async function paperFetch<T>(
  path: string,
  idToken: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
      ...(init?.headers ?? {}),
    },
  });

  const json = (await res.json().catch(() => null)) as {
    data?: T;
    error?: string;
    code?: string;
    status?: number;
  } | null;

  if (!res.ok) {
    throw new PaperApiError(
      json?.error || `Paper API request failed (HTTP ${res.status})`,
      json?.status ?? res.status,
      json?.code ?? 'PAPER_API_ERROR',
    );
  }

  if (!json || json.data === undefined) {
    throw new PaperApiError('Malformed Paper API response envelope', 502, 'MALFORMED_RESPONSE');
  }
  return json.data;
}

export async function listPaperSessionsApi(idToken: string): Promise<PaperSessionState[]> {
  const data = await paperFetch<{ sessions: PaperSessionState[] }>('/api/paper/sessions', idToken);
  return data.sessions;
}

export async function createPaperSessionApi(
  idToken: string,
  body: {
    symbol: string;
    resolution: '15m' | '1h';
    startingBalanceUsdt?: string;
    resetTimeZone?: string;
    riskLimits?: Partial<PaperRiskLimits>;
  },
): Promise<PaperSessionState> {
  return paperFetch<PaperSessionState>('/api/paper/sessions', idToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function restorePaperSessionApi(
  idToken: string,
  sessionId: string,
  snapshot: PaperRestoreSnapshotPayload,
): Promise<{
  state: PaperSessionState;
  replayedBars: number;
  replayedTradesCount: number;
}> {
  return paperFetch(`/api/paper/sessions/${encodeURIComponent(sessionId)}/restore`, idToken, {
    method: 'POST',
    body: JSON.stringify(snapshot),
  });
}

export async function getPaperSessionApi(
  idToken: string,
  sessionId: string,
): Promise<PaperSessionState> {
  return paperFetch<PaperSessionState>(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}`,
    idToken,
  );
}

export async function deletePaperSessionApi(
  idToken: string,
  sessionId: string,
): Promise<{ deleted: boolean; sessionId: string }> {
  return paperFetch(`/api/paper/sessions/${encodeURIComponent(sessionId)}`, idToken, {
    method: 'DELETE',
  });
}

export async function updatePaperSettingsApi(
  idToken: string,
  sessionId: string,
  body: {
    strategyEnabled?: boolean;
    resetTimeZone?: string;
    riskLimits?: Partial<PaperRiskLimits>;
    activeVersion?: PaperParameterVersion;
    resetDailyLossHalt?: boolean;
    resetDrawdownHalt?: boolean;
    resetKillSwitch?: boolean;
    resetStaleSession?: boolean;
  },
): Promise<PaperSessionState> {
  return paperFetch<PaperSessionState>(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}/settings`,
    idToken,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export async function submitPaperOrderApi(
  idToken: string,
  sessionId: string,
  body: {
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    contracts: number;
    limitPriceTicks?: number | null;
    stopLossTicks?: number | null;
    takeProfitTicks?: number | null;
    reduceOnly?: boolean;
  },
): Promise<{
  state: PaperSessionState;
  order: PaperOrder;
  fill: PaperFill | null;
  closedTrade: PaperClosedTrade | null;
  idempotentDuplicate: boolean;
}> {
  const res = await fetch(`/api/paper/sessions/${encodeURIComponent(sessionId)}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as {
    data?: {
      state: PaperSessionState;
      order: PaperOrder;
      fill: PaperFill | null;
      closedTrade: PaperClosedTrade | null;
      idempotentDuplicate: boolean;
    };
    error?: string;
    code?: string;
    status?: number;
  } | null;

  if (!json?.data && !res.ok) {
    throw new PaperApiError(
      json?.error || `Order request failed (HTTP ${res.status})`,
      json?.status ?? res.status,
      json?.code ?? 'ORDER_FAILED',
    );
  }
  if (!json?.data) {
    throw new PaperApiError('Malformed order response', 502, 'MALFORMED_RESPONSE');
  }
  return json.data;
}

export async function cancelPaperOrderApi(
  idToken: string,
  sessionId: string,
  clientOrderId: string,
): Promise<{ state: PaperSessionState; cancelledOrder: PaperOrder | null }> {
  return paperFetch(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}/orders/${encodeURIComponent(clientOrderId)}`,
    idToken,
    { method: 'DELETE' },
  );
}

export async function triggerKillSwitchApi(
  idToken: string,
  sessionId: string,
): Promise<{
  state: PaperSessionState;
  closedTrades: PaperClosedTrade[];
  cancelledOrders: PaperOrder[];
  fills: PaperFill[];
}> {
  return paperFetch(`/api/paper/sessions/${encodeURIComponent(sessionId)}/kill-switch`, idToken, {
    method: 'POST',
  });
}

export async function fetchPaperAnalyticsApi(
  idToken: string,
  sessionId: string,
): Promise<{ analytics: PaperTradeAnalytics; drift: PaperDriftReport }> {
  return paperFetch(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}/analytics`,
    idToken,
  );
}

export async function runWalkForwardApi(
  idToken: string,
  sessionId: string,
  body: { fixedHalfSpreadTicks: number; lookbackBars: number },
): Promise<WalkForwardReport> {
  return paperFetch<WalkForwardReport>(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}/walk-forward`,
    idToken,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function evaluateHeldOutApi(
  idToken: string,
  sessionId: string,
  body: { version: PaperParameterVersion; lookbackBars: number },
): Promise<{
  summary: WalkForwardSplitSummary;
  log: HeldOutEvaluationLog;
  account: PaperAccount;
}> {
  return paperFetch(
    `/api/paper/sessions/${encodeURIComponent(sessionId)}/held-out`,
    idToken,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export async function explainClosedTradeApi(
  idToken: string,
  body: ExplainClosedTradeRequest,
): Promise<ExplainClosedTradeResponse> {
  return paperFetch<ExplainClosedTradeResponse>('/api/paper/explain-trade', idToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
