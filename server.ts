import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDeltaRouter } from './server/routes/delta.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';
  const portArgIndex = process.argv.indexOf('--port');
  const cliPort = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : NaN;
  const port =
    Number.isFinite(cliPort) && cliPort > 0
      ? cliPort
      : isProd && !process.env.NGINX_PORT
        ? Number(process.env.PORT) || 3000
        : Number(process.env.DEFAULT_APP_PORT) || 3000;

  app.use(express.json({ limit: '1mb' }));

  // Public read-only Delta Exchange India proxy routes
  app.use('/api', createDeltaRouter());

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
    console.log(`[RegimeSentinel] Server listening on http://0.0.0.0:${port} (mode=${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('[RegimeSentinel] Fatal server startup error:', err);
  process.exit(1);
});
