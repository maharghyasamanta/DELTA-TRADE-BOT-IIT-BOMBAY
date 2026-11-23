import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  checkDeltaRestHealth,
  DeltaApiError,
  fetchCandlesHistory,
  fetchLiveProducts,
  fetchTickerSnapshot,
  getClientTelemetry,
} from '../deltaClient.ts';
import { deltaStreamManager } from '../deltaStream.ts';
import {
  ALLOWED_RESOLUTIONS,
  type ApiEnvelope,
  type ApiErrorResponse,
  type CandlePriceBasis,
  type CandleResolution,
  type DeltaStreamEvent,
  type HealthStatusResponse,
} from '../../src/contracts/delta.ts';

const SYMBOL_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
  source = 'Delta Exchange India Proxy',
): void {
  const body: ApiErrorResponse = {
    error,
    code,
    status,
    source,
    timestamp: new Date().toISOString(),
  };
  res.status(status).json(body);
}

function isAllowedResolution(value: string): value is CandleResolution {
  return (ALLOWED_RESOLUTIONS as readonly string[]).includes(value);
}

export function createDeltaRouter(): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    const restHealth = await checkDeltaRestHealth();
    const clientTel = getClientTelemetry();
    const wsTel = deltaStreamManager.getTelemetry();

    const payload: HealthStatusResponse = {
      ok: restHealth.ok,
      deltaRestOk: restHealth.ok,
      deltaRestLatencyMs: restHealth.latencyMs,
      deltaWsState: wsTel.wsState,
      lastRestSuccessAt: clientTel.lastRestSuccessAt,
      lastWsMessageAt: wsTel.lastWsMessageAt,
      lastError: restHealth.error || clientTel.lastRestError || wsTel.lastWsError,
      cacheStats: {
        productsCached: clientTel.productsCached,
        productsAgeMs: clientTel.productsAgeMs,
        candleCacheEntries: clientTel.candleCacheEntries,
      },
      checkedAt: new Date().toISOString(),
    };

    res.status(restHealth.ok ? 200 : 503).json(payload);
  });

  router.get('/delta/products', async (req: Request, res: Response) => {
    try {
      const { payload, cached, fetchedAt } = await fetchLiveProducts();

      const typeFilter = typeof req.query.type === 'string' ? req.query.type.trim() : '';
      const underlyingFilter =
        typeof req.query.underlying === 'string' ? req.query.underlying.trim().toUpperCase() : '';
      const queryText = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

      let filtered = payload.products;
      if (typeFilter && typeFilter !== 'all') {
        filtered = filtered.filter((p) => p.contractType === typeFilter);
      }
      if (underlyingFilter && underlyingFilter !== 'ALL') {
        filtered = filtered.filter(
          (p) => p.underlyingSymbol.toUpperCase() === underlyingFilter,
        );
      }
      if (queryText) {
        filtered = filtered.filter(
          (p) =>
            p.symbol.toLowerCase().includes(queryText) ||
            p.description.toLowerCase().includes(queryText),
        );
      }

      const envelope: ApiEnvelope<typeof payload> = {
        data: {
          products: filtered,
          underlyings: payload.underlyings,
          totalCount: filtered.length,
        },
        source: 'Delta Exchange India REST /v2/products',
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      if (err instanceof DeltaApiError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      sendError(
        res,
        502,
        'PRODUCTS_FETCH_FAILED',
        err instanceof Error ? err.message : 'Failed to load products from Delta Exchange India',
      );
    }
  });

  router.get('/delta/ticker/:symbol', async (req: Request, res: Response) => {
    const rawSymbol = req.params.symbol;
    const symbol = typeof rawSymbol === 'string' ? rawSymbol.trim() : '';

    if (!SYMBOL_REGEX.test(symbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Invalid instrument symbol format', 'Server Validator');
      return;
    }

    try {
      const { ticker, fetchedAt } = await fetchTickerSnapshot(symbol);
      const envelope: ApiEnvelope<typeof ticker> = {
        data: ticker,
        source: `Delta Exchange India REST /v2/tickers/${symbol}`,
        fetchedAt,
        cached: false,
      };
      res.json(envelope);
    } catch (err) {
      if (err instanceof DeltaApiError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      sendError(
        res,
        502,
        'TICKER_FETCH_FAILED',
        err instanceof Error ? err.message : 'Failed to fetch ticker snapshot',
      );
    }
  });

  router.get('/delta/candles', async (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const resolutionRaw =
      typeof req.query.resolution === 'string' ? req.query.resolution.trim() : '15m';
    const basisRaw = typeof req.query.basis === 'string' ? req.query.basis.trim() : 'trade';
    const startRaw = typeof req.query.start === 'string' ? Number(req.query.start) : NaN;
    const endRaw = typeof req.query.end === 'string' ? Number(req.query.end) : NaN;

    if (!SYMBOL_REGEX.test(symbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Invalid or missing symbol parameter', 'Server Validator');
      return;
    }
    if (!isAllowedResolution(resolutionRaw)) {
      sendError(
        res,
        400,
        'INVALID_RESOLUTION',
        `Unsupported resolution "${resolutionRaw}". Allowed: ${ALLOWED_RESOLUTIONS.join(', ')}`,
        'Server Validator',
      );
      return;
    }
    if (basisRaw !== 'trade' && basisRaw !== 'mark') {
      sendError(
        res,
        400,
        'INVALID_BASIS',
        'basis must be either "trade" or "mark"',
        'Server Validator',
      );
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const end = Number.isFinite(endRaw) && endRaw > 0 ? Math.floor(endRaw) : nowSec;
    const start =
      Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : end - 86_400;

    if (start >= end) {
      sendError(
        res,
        400,
        'INVALID_TIME_RANGE',
        'start timestamp must be strictly earlier than end timestamp',
        'Server Validator',
      );
      return;
    }

    try {
      const { payload, cached, fetchedAt } = await fetchCandlesHistory({
        symbol,
        resolution: resolutionRaw,
        start,
        end,
        basis: basisRaw as CandlePriceBasis,
      });

      const envelope: ApiEnvelope<typeof payload> = {
        data: payload,
        source: `Delta Exchange India REST /v2/history/candles (${payload.querySymbol})`,
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      if (err instanceof DeltaApiError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      sendError(
        res,
        502,
        'CANDLES_FETCH_FAILED',
        err instanceof Error ? err.message : 'Failed to load historical candles',
      );
    }
  });

  router.get('/delta/stream', (req: Request, res: Response) => {
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const resolutionRaw =
      typeof req.query.resolution === 'string' ? req.query.resolution.trim() : '15m';
    const basisRaw = typeof req.query.basis === 'string' ? req.query.basis.trim() : 'trade';

    if (!SYMBOL_REGEX.test(symbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Invalid or missing symbol parameter', 'Server Validator');
      return;
    }
    if (!isAllowedResolution(resolutionRaw)) {
      sendError(res, 400, 'INVALID_RESOLUTION', 'Unsupported resolution', 'Server Validator');
      return;
    }
    const basis: CandlePriceBasis = basisRaw === 'mark' ? 'mark' : 'trade';
    const querySymbol = basis === 'mark' ? `MARK:${symbol}` : symbol;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const writeEvent = (event: DeltaStreamEvent) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    const subId = randomUUID();
    const unsubscribe = deltaStreamManager.addSubscriber({
      id: subId,
      symbol,
      resolution: resolutionRaw,
      basis,
      querySymbol,
      send: writeEvent,
    });

    const keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepAliveTimer);
      unsubscribe();
    });
  });

  return router;
}
