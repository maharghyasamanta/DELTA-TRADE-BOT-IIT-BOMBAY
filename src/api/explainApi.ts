import type {
  ExplainApiEnvelope,
  ExplainApiErrorResponse,
  ExplainSnapshotRequest,
  ExplainStatusResponse,
} from '../contracts/explain';

export class ExplainProxyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly source: string;
  readonly timestamp: string;
  readonly offendingNumbers?: number[];
  readonly matchedWords?: string[];

  constructor(payload: ExplainApiErrorResponse) {
    super(payload.error);
    this.name = 'ExplainProxyError';
    this.status = payload.status;
    this.code = payload.code;
    this.source = payload.source;
    this.timestamp = payload.timestamp;
    this.offendingNumbers = payload.offendingNumbers;
    this.matchedWords = payload.matchedWords;
  }
}

async function parseError(res: Response): Promise<ExplainProxyError> {
  try {
    const body = (await res.json()) as Partial<ExplainApiErrorResponse>;
    return new ExplainProxyError({
      error: body.error || `Request failed with HTTP ${res.status}`,
      code: body.code || 'EXPLAIN_PROXY_ERROR',
      status: body.status ?? res.status,
      source: 'Gemini Explain Proxy',
      timestamp: body.timestamp || new Date().toISOString(),
      offendingNumbers: Array.isArray(body.offendingNumbers) ? body.offendingNumbers : undefined,
      matchedWords: Array.isArray(body.matchedWords) ? body.matchedWords : undefined,
    });
  } catch {
    return new ExplainProxyError({
      error: `Request failed with HTTP ${res.status}`,
      code: 'EXPLAIN_PROXY_ERROR',
      status: res.status,
      source: 'Gemini Explain Proxy',
      timestamp: new Date().toISOString(),
    });
  }
}

export async function fetchExplainStatus(signal?: AbortSignal): Promise<ExplainStatusResponse> {
  const res = await fetch('/api/explain/status', { signal });
  if (!res.ok) {
    throw await parseError(res);
  }
  return (await res.json()) as ExplainStatusResponse;
}

export async function requestExplanation(
  snapshot: ExplainSnapshotRequest,
  signal?: AbortSignal,
): Promise<ExplainApiEnvelope> {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
    signal,
  });

  if (!res.ok) {
    throw await parseError(res);
  }

  return (await res.json()) as ExplainApiEnvelope;
}
