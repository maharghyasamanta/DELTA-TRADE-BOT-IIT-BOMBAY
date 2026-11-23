import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createDeltaRouter } from './server/routes/delta.ts';
import { createAlpacaRouter } from './server/routes/alpaca.ts';
import { createExplainRouter } from './server/routes/explain.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GLOBAL_API_RATE_LIMIT_MAX = 180; // per IP per minute across all /api routes
const GLOBAL_API_RATE_LIMIT_WINDOW_MS = 60_000;
const apiRateLimitMap = new Map<string, number[]>();

function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return 1;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : raw;
}

function globalApiRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - GLOBAL_API_RATE_LIMIT_WINDOW_MS;
  const recent = (apiRateLimitMap.get(clientIp) ?? []).filter((ts) => ts > windowStart);

  if (recent.length >= GLOBAL_API_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((recent[0] + GLOBAL_API_RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    apiRateLimitMap.set(clientIp, recent);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: `Too many API requests (${GLOBAL_API_RATE_LIMIT_MAX} per minute per IP). Retry in ${retryAfterSec}s.`,
      code: 'RATE_LIMITED',
      status: 429,
      source: 'API Rate Limiter',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  recent.push(now);
  apiRateLimitMap.set(clientIp, recent);

  if (apiRateLimitMap.size > 1000) {
    for (const [k, timestamps] of apiRateLimitMap.entries()) {
      if (timestamps.every((ts) => ts <= windowStart)) {
        apiRateLimitMap.delete(k);
      }
    }
  }

  next();
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', resolveTrustProxy());

  const isProd = process.env.NODE_ENV === 'production';
  const portArgIndex = process.argv.indexOf('--port');
  const cliPort = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : NaN;
  const port =
    Number.isFinite(cliPort) && cliPort > 0
      ? cliPort
      : isProd && !process.env.NGINX_PORT
        ? Number(process.env.PORT) || 3000
        : Number(process.env.DEFAULT_APP_PORT) || 3000;

  // Global /api per-IP rate limiting + route-specific strict body limit for /api/explain
  app.use('/api', globalApiRateLimiter);
  app.use('/api/explain', express.json({ limit: '8kb' }));
  app.use(express.json({ limit: '1mb' }));

  // Public read-only market data & explain proxy routes
  app.use('/api', createDeltaRouter());
  app.use('/api', createAlpacaRouter());
  app.use('/api', createExplainRouter());

  // Structured JSON error handler for body-parser & /api errors (prevents HTML responses)
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errObj = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
    const type = typeof errObj.type === 'string' ? errObj.type : '';
    const rawStatus =
      typeof errObj.status === 'number' && Number.isFinite(errObj.status) ? errObj.status : 500;

    if (type === 'entity.too.large' || rawStatus === 413) {
      res.status(413).json({
        error: 'Request payload exceeds allowed body limit',
        code: 'BODY_TOO_LARGE',
        status: 413,
        source: 'API Request Parser',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({
        error: 'Malformed JSON request body',
        code: 'INVALID_JSON',
        status: 400,
        source: 'API Request Parser',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500).json({
      error: err instanceof Error ? err.message : 'Internal server error',
      code: 'API_INTERNAL_ERROR',
      status: rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500,
      source: 'API Server',
      timestamp: new Date().toISOString(),
    });
  });

  // Catch-all JSON 404 for unknown /api/* routes before SPA / Vite HTML fallback
  app.all('/api/*', (req: Request, res: Response) => {
    res.status(404).json({
      error: `Unknown API route: ${req.method} ${req.originalUrl}`,
      code: 'NOT_FOUND',
      status: 404,
      source: 'API Router',
      timestamp: new Date().toISOString(),
    });
  });

  if (isProd) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });

    app.use(vite.middlewares);

    app.get('*', async (req, res, next) => {
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        const template = fs.readFileSync(indexPath, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(
      `[RegimeSentinel] Server listening on http://0.0.0.0:${port} (mode=${isProd ? 'production' : 'development'})`,
    );
  });
}

startServer().catch((err) => {
  console.error('[RegimeSentinel] Fatal server startup error:', err);
  process.exit(1);
});
