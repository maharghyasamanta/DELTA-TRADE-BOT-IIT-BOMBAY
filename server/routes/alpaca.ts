import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  ALPACA_CONFIGURED,
  AlpacaApiError,
  AlpacaNotConfiguredError,
  fetchAlpacaBarsWithMeta,
  fetchAlpacaLatestQuoteWithMeta,
  fetchAlpacaLatestTradeWithMeta,
  getAlpacaTelemetry,
} from '../alpacaClient.ts';
import {
  ALPACA_TIMEFRAMES,
  type AlpacaApiEnvelope,
  type AlpacaApiErrorResponse,
  type AlpacaBarsResponse,
  type AlpacaFeed,
  type AlpacaStatusResponse,
  type AlpacaTimeframe,
  type AlpacaValidateResponse,
} from '../../src/contracts/alpaca.ts';
import { normalizeAlpacaBars } from '../../src/utils/normalizeAlpacaBars.ts';

const SYMBOL_REGEX = /^[A-Z]{1,10}$/;

function sendError(
  res: Response,
  status: number,
  code: string,
  error: string,
  source = 'Alpaca Market Data Proxy',
): void {
  const body: AlpacaApiErrorResponse = {
    error,
    code,
    status,
    source,
    timestamp: new Date().toISOString(),
  };
  res.status(status).json(body);
}

function handleAlpacaRouteError(res: Response, err: unknown, fallbackCode: string): void {
  if (err instanceof AlpacaNotConfiguredError) {
    sendError(res, 503, 'ALPACA_NOT_CONFIGURED', err.message);
    return;
  }
  if (err instanceof AlpacaApiError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  sendError(
    res,
    502,
    fallbackCode,
    err instanceof Error ? err.message : 'Failed to fetch from Alpaca Market Data',
  );
}

function isAllowedTimeframe(value: string): value is AlpacaTimeframe {
  return (ALPACA_TIMEFRAMES as readonly string[]).includes(value);
}

export function createAlpacaRouter(): Router {
  const router = Router();

  router.get('/alpaca/status', (_req: Request, res: Response) => {
    const telemetry = getAlpacaTelemetry();
    const payload: AlpacaStatusResponse = {
      configured: telemetry.configured,
      lastSuccessAt: telemetry.lastSuccessAt,
      lastError: telemetry.lastError,
      checkedAt: new Date().toISOString(),
    };
    res.status(200).json(payload);
  });

  router.get('/alpaca/validate/:symbol', async (req: Request, res: Response) => {
    if (!ALPACA_CONFIGURED) {
      const err = new AlpacaNotConfiguredError();
      sendError(res, 503, 'ALPACA_NOT_CONFIGURED', err.message);
      return;
    }

    const rawSymbol = typeof req.params.symbol === 'string' ? req.params.symbol.trim() : '';
    if (!SYMBOL_REGEX.test(rawSymbol)) {
      sendError(
        res,
        400,
        'INVALID_SYMBOL',
        'Symbol must match /^[A-Z]{1,10}$/',
        'Alpaca Market Data Proxy',
      );
      return;
    }

    try {
      const { trade, cached, fetchedAt } = await fetchAlpacaLatestTradeWithMeta(rawSymbol);
      const envelope: AlpacaApiEnvelope<AlpacaValidateResponse> = {
        data: {
          valid: true,
          symbol: rawSymbol,
          trade,
        },
        source: `Alpaca Market Data /v2/stocks/${rawSymbol}/trades/latest`,
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      handleAlpacaRouteError(res, err, 'SYMBOL_VALIDATION_FAILED');
    }
  });

  router.get('/alpaca/bars', async (req: Request, res: Response) => {
    if (!ALPACA_CONFIGURED) {
      const err = new AlpacaNotConfiguredError();
      sendError(res, 503, 'ALPACA_NOT_CONFIGURED', err.message);
      return;
    }

    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const timeframeRaw =
      typeof req.query.timeframe === 'string' ? req.query.timeframe.trim() : '';
    const start = typeof req.query.start === 'string' ? req.query.start.trim() : '';
    const end = typeof req.query.end === 'string' ? req.query.end.trim() : '';
    const feedRaw = typeof req.query.feed === 'string' ? req.query.feed.trim().toLowerCase() : '';

    if (!SYMBOL_REGEX.test(symbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Symbol must match /^[A-Z]{1,10}$/');
      return;
    }
    if (!isAllowedTimeframe(timeframeRaw)) {
      sendError(
        res,
        400,
        'INVALID_TIMEFRAME',
        `Unsupported timeframe "${timeframeRaw}". Allowed: ${ALPACA_TIMEFRAMES.join(', ')}`,
      );
      return;
    }
    if (!start || !end) {
      sendError(res, 400, 'INVALID_TIME_RANGE', 'start and end query parameters are required');
      return;
    }

    let feed: AlpacaFeed | undefined;
    if (feedRaw) {
      if (feedRaw !== 'iex' && feedRaw !== 'sip') {
        sendError(res, 400, 'INVALID_FEED', 'feed must be either "iex" or "sip"');
        return;
      }
      feed = feedRaw;
    }

    try {
      const { bars: rawBars, cached, fetchedAt } = await fetchAlpacaBarsWithMeta(
        symbol,
        timeframeRaw,
        start,
        end,
        feed,
      );
      const bars = normalizeAlpacaBars(rawBars);
      const payload: AlpacaBarsResponse = {
        bars,
        symbol,
        timeframe: timeframeRaw,
        feed: feed ?? null,
        fetchedAt,
      };
      const envelope: AlpacaApiEnvelope<AlpacaBarsResponse> = {
        data: payload,
        source: `Alpaca Market Data /v2/stocks/${symbol}/bars`,
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      handleAlpacaRouteError(res, err, 'BARS_FETCH_FAILED');
    }
  });

  router.get('/alpaca/quote/:symbol', async (req: Request, res: Response) => {
    if (!ALPACA_CONFIGURED) {
      const err = new AlpacaNotConfiguredError();
      sendError(res, 503, 'ALPACA_NOT_CONFIGURED', err.message);
      return;
    }

    const rawSymbol = typeof req.params.symbol === 'string' ? req.params.symbol.trim() : '';
    if (!SYMBOL_REGEX.test(rawSymbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Symbol must match /^[A-Z]{1,10}$/');
      return;
    }

    try {
      const { quote, cached, fetchedAt } = await fetchAlpacaLatestQuoteWithMeta(rawSymbol);
      const envelope: AlpacaApiEnvelope<unknown> = {
        data: quote,
        source: `Alpaca Market Data /v2/stocks/${rawSymbol}/quotes/latest`,
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      handleAlpacaRouteError(res, err, 'QUOTE_FETCH_FAILED');
    }
  });

  router.get('/alpaca/trade/:symbol', async (req: Request, res: Response) => {
    if (!ALPACA_CONFIGURED) {
      const err = new AlpacaNotConfiguredError();
      sendError(res, 503, 'ALPACA_NOT_CONFIGURED', err.message);
      return;
    }

    const rawSymbol = typeof req.params.symbol === 'string' ? req.params.symbol.trim() : '';
    if (!SYMBOL_REGEX.test(rawSymbol)) {
      sendError(res, 400, 'INVALID_SYMBOL', 'Symbol must match /^[A-Z]{1,10}$/');
      return;
    }

    try {
      const { trade, cached, fetchedAt } = await fetchAlpacaLatestTradeWithMeta(rawSymbol);
      const envelope: AlpacaApiEnvelope<unknown> = {
        data: trade,
        source: `Alpaca Market Data /v2/stocks/${rawSymbol}/trades/latest`,
        fetchedAt,
        cached,
      };
      res.json(envelope);
    } catch (err) {
      handleAlpacaRouteError(res, err, 'TRADE_FETCH_FAILED');
    }
  });

  return router;
}
