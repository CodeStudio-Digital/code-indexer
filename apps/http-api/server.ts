import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { createAdminRouter } from './admin/index.js';
import { createDeps } from './server/deps.js';
import { mountProjectsRoutes } from './server/routes/projects.js';
import { mountHygieneRoutes } from './server/routes/hygiene.js';
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
import { mountTelemetryRoutes } from './server/routes/telemetry.js';
import { mountCoderRoutes } from './server/routes/coder/index.js';
import { mountPreviewRoutes, attachPreviewUpgrade } from './server/routes/preview.js';
import { mountWorkspaceRoutes } from './server/routes/workspace/index.js';
import {
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
} from '@mcp/services/sandbox/sandbox-manager.js';
import { setCompanyLocalProjectStore } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';
import { setEnvToolStore } from '@mcp/company/tools/env-tools.js';
import { setDatabaseToolStores } from '@mcp/company/tools/database-tools.js';
import { createMcpHttpApp } from '../mcp-server/http/mcp-http-transport.js';
import { composeAuth } from './auth/composition.js';
import { bearerMiddleware, getAuthCtx } from './auth/bearer-middleware.js';
import { createApiTokensRouter } from './admin/api-tokens.routes.js';
import { createOAuthClientsRouter } from './admin/oauth-clients.routes.js';
import { createAuditLogRouter } from './admin/audit-log.routes.js';
import { createWellKnownRouter } from './oauth/well-known.routes.js';
import { createOAuthRouter } from './oauth/index.js';
import { composeMcpClientAuth } from '@mcp/services/mcp-client/auth/composition.js';
import { createMcpServersOauthRouter } from './admin/mcp-servers-oauth.routes.js';
import { mergeDBCapabilities } from '@mcp/code-agent/providers/capabilities.js';
import { startProviderRefreshScheduler } from '@mcp/indexer/indexer/providers/scheduled-refresh.js';
import { ensureBuiltinSkills } from '@mcp/indexer/bootstrap/ensure-builtin-skills.js';
import {
  setQaTestRunStore,
  setQaEndpointEnvStore,
} from '@mcp/company/tools/qa/index.js';
import { startQaWatchdog } from '@mcp/services/qa/watchdog.js';
import { setDesignSystemStore, setDesignSystemSkillStore } from '@mcp/company/tools/design-system/index.js';
import { ChromeService, setChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { VerdaccioService, setVerdaccioService } from '@mcp/services/verdaccio/verdaccio-service.js';
import {
  setSandboxServiceEnvStore,
  hasQaPlaywrightSkill,
} from '@mcp/company/services/SandboxService.js';
import { setQaPreviewConfig } from '@mcp/services/sandbox/sandbox-manager.js';
import { mountDesignSystemRoutes } from './server/routes/design-system/index.js';
import { mountConfigRoutes } from './server/routes/config.js';
import { closeDbWriter } from '@mcp/indexer/workers/dbWriter/client.js';
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';

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
  setQaTestRunStore(deps.qaTestRunStore);
  setQaEndpointEnvStore(deps.companySessionEnvStore);
  // Design System is gated by DESIGN_SYSTEM_ENABLED (default ON). When off,
  // the store/skill-store stay un-wired AND the /api/design-system/* routes
  // are skipped below, so the whole module is dormant in one shot.
  if (deps.config.features.designSystemEnabled) {
    setDesignSystemStore(deps.designSystemStore);
    setDesignSystemSkillStore(deps.skillStore);
  }
  setSandboxServiceEnvStore(deps.companySessionEnvStore);

  // Wire QA preview-routing config (v4.3). Lets `syncManagedEnvs` mint
  // long-lived `PLAYWRIGHT_BASE_URL_*` URLs pointing at this http-api
  // process from sibling containers (the Chrome Service). Gated by
  // `hasQaPlaywrightSkill` so non-QA sessions don't get the env vars.
  setQaPreviewConfig({
    httpApiPort: deps.config.dashboard.port,
    hasQaPlaywrightSkill: (sessionId: number) => {
      try {
        const session = deps.companyStore.getCompanySession(sessionId);
        return session ? hasQaPlaywrightSkill(session.config_json ?? '') : false;
      } catch {
        return false;
      }
    },
  });

  // Wire the Chrome Service singleton so the admin routes + the QA
  // tools can observe lifecycle. Boot recovery (auto-start when
  // `enabled=true` in the DB) runs below after migrations finish.
  const chromeService = new ChromeService({
    store: deps.chromeServiceStore,
    companyStore: deps.companyStore,
    envStore: deps.companySessionEnvStore,
    httpApiPort: deps.config.dashboard.port,
  });
  setChromeService(chromeService);

  // Verdaccio singleton — embedded npm registry for the Design System
  // Creator pipeline. Boot recovery is handled together with chrome's,
  // both best-effort.
  const verdaccioService = new VerdaccioService({
    store: deps.verdaccioStore,
  });
  setVerdaccioService(verdaccioService);

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

  // QA test runs: any row in `status='running'` after restart cannot be
  // a live Playwright invocation (the host process is gone). Mark them
  // aborted so the dashboard's TestsTab stops showing the spinner
  // forever. See sessão 68 incident (run id=1 stuck running).
  try {
    const { recovered } = deps.qaTestRunStore.recoverStaleRuns();
    if (recovered > 0) {
      console.log(`[qa-recovery] Boot: ${recovered} stale qa_test_runs aborted`);
    }
  } catch (e) {
    console.warn(`[qa-recovery] Boot failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // QA orphan-run watchdog (v4.4): every minute, sweep `running` rows
  // that have received zero `qa_test_results` for >10 min and mark them
  // `errored`. Closes the door on session-68-style ghost runs where the
  // streaming reporter was wired wrong but the agent moved on.
  startQaWatchdog(deps.qaTestRunStore);

  // Verdaccio auto-start: same idempotent pattern as chrome-service.
  void verdaccioService.recoverOnBoot().catch((e) => {
    console.warn(
      `[verdaccio] Boot recovery failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  // Seed builtin skills (e.g. `qa-playwright`) into the DB. Idempotent —
  // re-runs on every boot, but only inserts/updates when the file's
  // `version` is newer than the existing row. User clones (different id
  // with `source='user'`) are never touched. Failures are non-fatal.
  try {
    const seeded = ensureBuiltinSkills(deps.skillStore);
    if (seeded.inserted.length > 0 || seeded.updated.length > 0) {
      console.log(
        `[builtin-skills] Boot: ${seeded.inserted.length} inserted, ${seeded.updated.length} updated, ${seeded.skippedSameVersion.length} unchanged`,
      );
    }
  } catch (e) {
    console.warn(
      `[builtin-skills] Boot seed failed: ${e instanceof Error ? e.message : String(e)}`,
    );
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
  mountHygieneRoutes(app, deps);
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
  mountTelemetryRoutes(app, deps);
  app.route('/api/admin', createAdminRouter(deps.providerStore));
  mountCoderRoutes(app, deps);
  mountConfigRoutes(app, deps);
  // Design System Creator routes (sessions / versions / storybook proxy).
  // Mounted after coder routes so the company sessions referenced by
  // DS sessions are already wired. Gated by DESIGN_SYSTEM_ENABLED — when
  // off the routes are unmounted and the menu entry is hidden.
  if (deps.config.features.designSystemEnabled) {
    mountDesignSystemRoutes(app, deps);
  }
  // Builder-mode sandbox preview proxy. Dormant for non-builder sessions
  // (the route 404s when no sandbox is registered for the sessionId).
  mountPreviewRoutes(app, deps);
  mountWorkspaceRoutes(app, deps);

  return { app, db: deps.db, chromeService };
}

export async function startServer(port: number, host: string) {
  const { app, chromeService } = createApp();
  console.log(`MCP Code Indexer API running at http://${host}:${port}`);
  // `serve()` returns the underlying Node http.Server. We need that
  // reference to attach the WebSocket upgrade handler for the preview
  // proxy (Vite HMR uses WS). Hono itself has no notion of upgrades.
  const server = serve({ fetch: app.fetch, port, hostname: host });
  attachPreviewUpgrade(server as unknown as import('node:http').Server);

  // Chrome Service auto-start deferred until after serve() so the
  // /api/health reachability probe inside recoverOnBoot finds the port open.
  void chromeService.recoverOnBoot().catch((e) => {
    console.warn(
      `[chrome-service] Boot recovery failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
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

// Drain the dbWriter worker on graceful shutdown so the latest assistant
// turn(s) land before the process exits. Without this, SIGINT/SIGTERM during
// an active session can drop pending writes.
let shuttingDown = false;
const gracefulShutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      await Promise.allSettled([closeDbWriter(), closeIndexJobPool()]);
    } catch (err) {
      console.error('[shutdown] worker pool close failed:', err);
    } finally {
      process.exit(signal === 'SIGTERM' ? 0 : 130);
    }
  })();
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Auto-start when executed directly
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').includes('api/server');
if (isDirectRun) {
  const cfg = loadConfig();
  startServer(cfg.dashboard.port, cfg.dashboard.host);
}
