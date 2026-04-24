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
import { mountPreviewRoutes, attachPreviewUpgrade } from './server/routes/preview.js';
import { mountWorkspaceRoutes } from './server/routes/workspace/index.js';
import {
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
} from '../../core/sandbox/sandbox-manager.js';
import { setCompanyLocalProjectStore } from '../../core/sandbox/local-process/LocalProcessManager.js';
import { setEnvToolStore } from '../../core/coder/tools/company/env-tools.js';
import { setDatabaseToolStores } from '../../core/coder/tools/company/database-tools.js';
import { createMcpHttpApp } from '../mcp-server/http/mcp-http-transport.js';
import { composeAuth } from './auth/composition.js';
import { bearerMiddleware, getAuthCtx } from './auth/bearer-middleware.js';
import { createApiTokensRouter } from './admin/api-tokens.routes.js';
import { createOAuthClientsRouter } from './admin/oauth-clients.routes.js';
import { createAuditLogRouter } from './admin/audit-log.routes.js';
import { createWellKnownRouter } from './oauth/well-known.routes.js';
import { createOAuthRouter } from './oauth/index.js';
import { composeMcpClientAuth } from '../../core/mcp-client/auth/composition.js';
import { createMcpServersOauthRouter } from './admin/mcp-servers-oauth.routes.js';
import { mergeDBCapabilities } from '../../core/coder/providers/capabilities.js';
import { startProviderRefreshScheduler } from '../../core/indexer/providers/scheduled-refresh.js';

export function createApp() {
  const deps = createDeps();

  // Wire the sandbox persistence store into the SandboxManager module
  // so its reconcile-on-boot + pause/resume paths can read/write DB.
  // Without this the manager falls back to in-memory-only behavior
  // (still works, but API restart wipes container mappings).
  setCompanySandboxStore(deps.companySandboxStore);
  setCompanySandboxServicesStore(deps.companySandboxServicesStore);
  setCompanySessionEnvStore(deps.companySessionEnvStore);
  setCompanyLocalProjectStore(deps.companyLocalProjectStore);
  setEnvToolStore(deps.companySessionEnvStore);
  setDatabaseToolStores(deps.companySessionDatabaseStore, deps.companySessionEnvStore);

  // Boot reconciliation for host-process runs. Anything left in a live
  // state by the previous server instance is impossible to re-attach
  // (PIDs can't be safely reclaimed across restarts), so we mark those
  // rows `destroyed` with error='server-restart'. The UI uses this to
  // show a Retry affordance with the same persisted command.
  try {
    const { cleaned, orphanedPids } = deps.companyLocalProjectStore.reconcileOnBoot();
    for (const pid of orphanedPids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    if (orphanedPids.length > 0) {
      setTimeout(() => {
        for (const pid of orphanedPids) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
      }, 3_000).unref();
    }
    if (cleaned > 0) {
      console.log(
        `[local-project] Boot: ${cleaned} row(s) → destroyed, ${orphanedPids.length} PID(s) SIGTERM'd`,
      );
    }
  } catch (e) {
    console.warn(
      `[local-project] Startup reconciliation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Hydrate the in-memory capability cache with DB-stored context_windows so
  // getModelContextWindow() returns accurate values from the very first request.
  try {
    mergeDBCapabilities(deps.providerStore.listAllModels());
  } catch (e) {
    console.warn(`[capabilities] DB hydration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Start background model refresh (populates context_window in DB from APIs).
  startProviderRefreshScheduler(deps.providerStore);

  // Startup recovery — any company agent run / session left in an active
  // state by a previous crashed/restarted server cannot possibly still be
  // running. Sweep them to `interrupted`/`paused` so the dashboard shows
  // a coherent state and users can resume via follow-up messages.
  try {
    const { agentRuns, companySessions } = deps.companyStore.recoverStaleAgentRuns();
    if (agentRuns > 0 || companySessions > 0) {
      console.log(
        `[company] Startup recovery: ${agentRuns} agent_run(s) → interrupted, ` +
        `${companySessions} company_session(s) → paused`,
      );
    }
  } catch (e) {
    console.warn(`[company] Startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const app = new Hono();

  app.use('*', cors({ origin: '*' }));

  // Auth subsystem — instantiated once per process. Adapters and use-cases
  // are wired here exclusively. Routes and middlewares depend on the bundle.
  const auth = composeAuth(deps.config);

  app.route('/api/admin', createApiTokensRouter(auth));
  app.route('/api/admin', createOAuthClientsRouter(auth));
  app.route('/api/admin', createAuditLogRouter(deps.config));

  // MCP client auth — enables OAuth 2.1 against external MCP servers that
  // our agent connects to. Independent from the inbound OAuth AS above.
  const mcpClientAuth = composeMcpClientAuth(deps.config.dbPath);
  deps.mcpBearerResolver = mcpClientAuth.resolveBearer;
  const publicBaseUrl = (): string =>
    `http://${deps.config.dashboard.host === '0.0.0.0' ? 'localhost' : deps.config.dashboard.host}:${deps.config.dashboard.port}`;
  app.route('/api/admin', createMcpServersOauthRouter(mcpClientAuth, publicBaseUrl));

  if (deps.config.mcp.oauth.enabled) {
    app.route('/', createWellKnownRouter(deps.config));
    app.route('/oauth', createOAuthRouter(auth, deps.config));
    console.log(`OAuth 2.1 AS enabled (issuer=${deps.config.mcp.oauth.issuer || '<auto>'}, dcr=${deps.config.mcp.oauth.allowDcr})`);
  }

  if (deps.config.mcp.http.enabled) {
    const authEnabled = deps.config.mcp.auth.enabled;
    const middleware = authEnabled
      ? bearerMiddleware({
          validate: auth.validate,
          enforceRate: auth.enforceRate,
          audit: auth.audit,
          issuer: deps.config.mcp.oauth.issuer || undefined,
          newRequestId: auth.newRequestId,
        })
      : undefined;

    const mcpApp = createMcpHttpApp(deps.config, {
      beforeTransport: middleware,
      resolveAuthContext: getAuthCtx,
      enforceScope: authEnabled ? auth.enforceScope : undefined,
      audit: auth.audit,
    });
    app.route(deps.config.mcp.http.path, mcpApp);
    console.log(
      `MCP HTTP endpoint mounted at ${deps.config.mcp.http.path}` +
        ` (stateful=${deps.config.mcp.http.stateful}, auth=${authEnabled})`,
    );
  }

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
  // Builder-mode sandbox preview proxy. Dormant for non-builder sessions
  // (the route 404s when no sandbox is registered for the sessionId).
  mountPreviewRoutes(app, deps);
  mountWorkspaceRoutes(app, deps);

  return { app, db: deps.db };
}

export async function startServer(port: number, host: string) {
  const { app } = createApp();
  console.log(`MCP Code Indexer API running at http://${host}:${port}`);
  // `serve()` returns the underlying Node http.Server. We need that
  // reference to attach the WebSocket upgrade handler for the preview
  // proxy (Vite HMR uses WS). Hono itself has no notion of upgrades.
  const server = serve({ fetch: app.fetch, port, hostname: host });
  attachPreviewUpgrade(server as unknown as import('node:http').Server);
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
