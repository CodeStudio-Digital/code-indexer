import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig } from '../../utils/config.js';
import { createAdminRouter } from './admin/index.js';
import { createDeps } from './server/deps.js';
import { mountProjectsRoutes } from './server/routes/projects.js';
import { mountSearchRoutes } from './server/routes/search.js';
import { mountFilesRoutes } from './server/routes/files.js';
import { mountGraphRoutes } from './server/routes/graph.js';
import { mountSnapshotsRoutes } from './server/routes/snapshots.js';
import { mountRunsRoutes } from './server/routes/runs.js';
import { mountDiffRoutes } from './server/routes/diff.js';
import { mountCostsRoutes } from './server/routes/costs.js';
import { mountWebhooksRoutes } from './server/routes/webhooks.js';
import { mountExportRoutes } from './server/routes/export.js';
import { mountModelsRoutes } from './server/routes/models.js';
import { mountStatsRoutes } from './server/routes/stats.js';
import { mountCoderRoutes } from './server/routes/coder/index.js';

export function createApp() {
  const deps = createDeps();
  const app = new Hono();

  app.use('*', cors({ origin: '*' }));

  mountProjectsRoutes(app, deps);
  mountSearchRoutes(app, deps);
  mountFilesRoutes(app, deps);
  mountGraphRoutes(app, deps);
  mountSnapshotsRoutes(app, deps);
  mountRunsRoutes(app, deps);
  mountDiffRoutes(app, deps);
  mountCostsRoutes(app, deps);
  mountWebhooksRoutes(app, deps);
  mountExportRoutes(app, deps);
  mountModelsRoutes(app, deps);
  mountStatsRoutes(app, deps);
  app.route('/api/admin', createAdminRouter(deps.providerStore));
  mountCoderRoutes(app, deps);

  return { app, db: deps.db };
}

export async function startServer(port: number, host: string) {
  const { app } = createApp();
  console.log(`MCP Code Indexer API running at http://${host}:${port}`);
  serve({ fetch: app.fetch, port, hostname: host });
}

// ── Periodic heap monitor ──────────────────────────────
// Helps diagnose memory leaks before they trigger an OOM crash.
const HEAP_LOG_INTERVAL_MS = Number(process.env.HEAP_LOG_INTERVAL_MS ?? 60_000);
if (HEAP_LOG_INTERVAL_MS > 0) {
  setInterval(() => {
    const mem = process.memoryUsage();
    console.error(
      `[heap] rss=${(mem.rss / 1e6).toFixed(0)}MB heap=${(mem.heapUsed / 1e6).toFixed(0)}/${(mem.heapTotal / 1e6).toFixed(0)}MB external=${(mem.external / 1e6).toFixed(0)}MB`,
    );
  }, HEAP_LOG_INTERVAL_MS).unref();
}

// Auto-start when executed directly
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('api/server');
if (isDirectRun) {
  const cfg = loadConfig();
  startServer(cfg.dashboard.port, cfg.dashboard.host);
}
