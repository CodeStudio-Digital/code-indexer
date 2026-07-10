import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { createAdminRouter } from './admin/index.js';
import { createDeps } from './server/deps.js';
import { mountProjectsRoutes } from './server/routes/projects.js';
import { sweepOrphanGlobalWorkspaces } from './server/routes/coder/global-workspace.js';
import { mountBuilderCheckpointRoutes } from './server/routes/builder-checkpoints.js';
import { mountProjectScaffoldRoute } from './server/routes/projects-scaffold.js';
import { mountHygieneRoutes } from './server/routes/hygiene.js';
import { mountSearchRoutes } from './server/routes/search.js';
import { mountFilesRoutes } from './server/routes/files.js';
import { mountDrawioStaticRoutes } from './server/routes/drawio-static.js';
import { mountGraphRoutes } from './server/routes/graph.js';
import { mountSnapshotsRoutes } from './server/routes/snapshots.js';
import { mountMemoryDiagnosticsRoutes } from './server/routes/memory-diagnostics.js';
import { mountAgentMemoryRoutes } from './server/routes/agent-memory.js';
import { mountUserMemoryRoutes } from './server/routes/user-memory.js';
import { mountRunsRoutes } from './server/routes/runs.js';
import { mountDiffRoutes } from './server/routes/diff.js';
import { mountCostsRoutes } from './server/routes/costs.js';
import { mountWebhooksRoutes } from './server/routes/webhooks.js';
import { mountExportRoutes } from './server/routes/export.js';
import { mountModelsRoutes } from './server/routes/models.js';
import { mountStatsRoutes } from './server/routes/stats.js';
import { mountTelemetryRoutes } from './server/routes/telemetry.js';
import { mountAdminPipelineBindingsRoutes } from './server/routes/admin/pipeline-bindings.js';
import { mountAdminPipelineTelemetryRoutes } from './server/routes/admin/pipeline-telemetry.js';
import { mountAdminQualityRoutes } from './server/routes/admin/quality.js';
import { mountAdminLshRoutes } from './server/routes/admin/lsh.js';
import { mountAdminDriftRoutes } from './server/routes/admin/drift.js';
import { mountWorkersDiagnosticRoute } from './server/routes/admin/workers.js';
import { mountSupervisorAdminRoutes } from './server/routes/admin/supervisor.js';
import { mountCoderRoutes } from './server/routes/coder/index.js';
import { mountLspRoutes } from './server/routes/lsp/lsp.routes.js';
import { mountEditorRoutes } from './server/routes/editor.js';
import { mountProjectGitRoutes } from './server/routes/project-git.js';
import { attachCompanyStreamUpgrade } from './server/routes/company/ws.js';
import { attachTerminalUpgrade, mountTerminalDiagnoseRoute } from './server/routes/terminal-ws.js';
import { mountWorkspaceRoutes } from './server/routes/workspace/index.js';
import {
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
} from '@mcp/services/sandbox/sandbox-manager.js';
import { setCompanyLocalProjectStore } from '@mcp/services/sandbox/local-process/LocalProcessManager.js';
import { setEnvToolStore } from '@mcp/company/tools/env-tools.js';
import { setDbToolsStores, setDbSecretDecryptor } from '@mcp/code-agent/tools/db/index.js';
import { getMainSecretDecryptor } from './server/secret-decrypt-port.js';
import {
  setGlobalToolSelectionFilter,
  setGlobalToolSelectionOutcomeObserver,
} from '@mcp/code-agent/tool-selection/index.js';
import {
  setGlobalQualityClassifierPipeline,
  setGlobalQualityClassificationStore,
  setGlobalQualityInterventionStore,
  setGlobalQualityResultObserver,
  setGlobalPolicyEnforcer,
  PolicyEnforcer,
  QualityWatchdog,
  setGlobalQualityWatchdog,
  type WatchdogChatRunner,
} from '@mcp/services/quality/index.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { setGlobalSubAgentCache } from '@mcp/services/sub-agent-cache/index.js';
import { setGlobalContextRelevancePipeline } from '@mcp/code-agent/context-relevance/index.js';
import { setGlobalFeedbackCollector } from '@mcp/services/shadow-traffic/index.js';
import { startInboxWatchdogIfEnabled, type InboxMessageWatchdog } from '@mcp/company/services/inbox-message-watchdog.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
// AgentSupervisor: workers-only architecture — each company-worker
// owns its own supervisor instance. Main process holds nothing.
import { subordinateCompletionBus } from '@mcp/company/services/subordinate/completion-events.js';
import { makeQualityAlertObserver } from './server/quality-observer.js';
import { createMcpHttpApp } from '../mcp-server/http/mcp-http-transport.js';
import { composeAuth } from './auth/composition.js';
import { bearerMiddleware, getAuthCtx } from './auth/bearer-middleware.js';
import { localhostOnlyMiddleware } from './server/middleware/localhost-only.js';
import { createApiTokensRouter } from './admin/api-tokens.routes.js';
import { createMcpHttpStatusRouter } from './admin/mcp-http-status.routes.js';
import { createAppSettingsRouter } from './admin/app-settings.routes.js';
import { createOAuthClientsRouter } from './admin/oauth-clients.routes.js';
import { createAuditLogRouter } from './admin/audit-log.routes.js';
import { createWellKnownRouter } from './oauth/well-known.routes.js';
import { createOAuthRouter } from './oauth/index.js';
import { composeMcpClientAuth } from '@mcp/services/mcp-client/auth/composition.js';
import { createMcpServersOauthRouter } from './admin/mcp-servers-oauth.routes.js';
import { mergeDBCapabilities } from '@mcp/code-agent/providers/capabilities.js';
import { mergeDBPricing } from '@mcp/code-agent/providers/pricing-cache.js';
import { hardcodedPriceSeed } from '@mcp/code-agent/providers/pricing.js';
import { startProviderRefreshScheduler } from '@mcp/indexer/indexer/providers/scheduled-refresh.js';
import { syncPluginProviders } from './server/plugin-providers.js';
import { seedBundledPlugins } from './server/bundled-plugins.js';
import { startModelPricingRefreshScheduler } from '@mcp/indexer/indexer/providers/scheduled-pricing-refresh.js';
import { getEnabledPriceSources } from '@mcp/services/services/pricing/index.js';
import { ensureBuiltinSkills } from '@mcp/indexer/bootstrap/ensure-builtin-skills.js';
import {
  setQaTestRunStore,
  setQaEndpointEnvStore,
} from '@mcp/company/tools/qa/index.js';
import { startQaWatchdog } from '@mcp/services/qa/watchdog.js';
import { setDesignSystemStore, setDesignSystemSkillStore } from '@mcp/company/tools/design-system/index.js';
import { setAppStudioDbClientStore, setAppStudioStore } from '@mcp/company/tools/app-studio/index.js';
import { setApiClientStore } from '@mcp/code-agent/tools/api-client/index.js';
import { ChromeService, setChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import { VerdaccioService, setVerdaccioService } from '@mcp/services/verdaccio/verdaccio-service.js';
import {
  setSandboxServiceEnvStore,
  hasQaPlaywrightSkill,
} from '@mcp/company/services/SandboxService.js';
import { setQaPreviewConfig } from '@mcp/services/sandbox/sandbox-manager.js';
import { mountDesignSystemRoutes } from './server/routes/design-system/index.js';
import { mountAppStudioRoutes } from './server/routes/app-studio/index.js';
import { mountSpriteStudioRoutes } from './server/routes/sprite-studio/index.js';
import { mountConfigRoutes } from './server/routes/config.js';
import { mountDocsRoutes } from './server/routes/docs/index.js';
import { mountDocsAgentRoutes } from './server/routes/docs-agent/index.js';
import { setChromeServiceForDocs } from './server/deps.js';
import { setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { recommendRolesForSession } from './server/routes/company/recommend-core.js';
import { setGlobalDocsHintProvider } from '@mcp/code-agent/core/docs-hint.js';
import { buildDocSearchBackend, buildDocsHintProvider } from './server/docs/search-backend.js';
import { setGlobalVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';
import { createVisionDescriber } from './server/vision-describer-impl.js';
import { setGlobalSpriteStudioHost } from '@mcp/code-agent/tools/sprite-studio/index.js';
import { createSpriteStudioHostImpl } from './server/sprite-studio-host-impl.js';
import {
  DocsResearchBridge,
  setGlobalDocsResearcher,
} from '@mcp/docs-agent/bridges/docs-bridge.js';
import {
  setCoderWorkerDocDeps,
  setCoderWorkerMcpPool,
  coderWorkerEnabled,
  getCoderWorkerPool,
} from './sse/coderWorkerPoolSingleton.js';
import { createIndexerExecutor } from './sse/IndexerWorkerClient.js';
import { startPerfSampler } from './server/perf/perf-sampler.js';
import { startFreezeWatchdog } from './server/perf/freeze-log.js';
import { getMemoryLedger } from './server/perf/memory-ledger.js';
import { mountPerfRoutes } from './server/routes/admin/perf.js';
import { createInProcessStructuralExecutor } from '@mcp/services/services/project-index/index.js';
import { registerShutdownTask } from './server/shutdown-tasks.js';
import {
  createLspHandlers,
  createContext,
  createInProcessLspExecutor,
  setLspExecutor,
  ensureLspManager,
} from '@mcp/api-handlers';
import { createLspExecutor } from './sse/lsp-executor.js';
import { setWorkerLspDeps } from './sse/worker-lsp-handlers.js';
import { setGlobalAgentLspBackend } from '@mcp/code-agent/lsp/agent-lsp-backend.js';
import { setCompanyWorkerDocDeps, getWorkerOrchestratorPool } from './sse/workerPoolSingleton.js';
import { McpExternalPool, setGlobalMcpExternalPool } from './sse/McpExternalPool.js';
// Frente E — periodic watchdog for stuck coder_sessions. Started during
// server bootstrap below; auto-`unref()` so it never holds process exit.
import { startCoderWatchdog } from './sse/coder-watchdog.js';
import { startMemorySweeper, memorySweeperEnabled } from './sse/memory-sweeper.js';
import { startMemoryConsolidator, memoryConsolidateEnabled } from './sse/memory-consolidator.js';
import { AppSettingsStore } from '@mcp/store/app-settings-store.js';
import { closeDbWriter } from '@mcp/indexer/workers/dbWriter/client.js';
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';

/**
 * Resolve and install the global Quality Watchdog (Apêndice 3 — tool-loop
 * detector). Reads env config, instantiates the cheap chat provider once,
 * and registers a `WatchdogChatRunner` that consumes the provider's stream
 * and joins the text deltas into a single reply string.
 *
 * Defensive: if the env disables the watchdog, the provider creation
 * fails, or the provider stream is unsupported, the global stays null
 * and the runner short-circuits the watchdog hook with zero overhead.
 */
async function wireQualityWatchdog(): Promise<void> {
  if (process.env.MCP_QUALITY_WATCHDOG_ENABLED === '0') {
    setGlobalQualityWatchdog(null);
    return;
  }
  const provider = process.env.MCP_QUALITY_WATCHDOG_PROVIDER ?? 'anthropic';
  const model = process.env.MCP_QUALITY_WATCHDOG_MODEL ?? 'claude-haiku-4-5';

  let chatProvider;
  try {
    chatProvider = await createCoderProvider(provider, model);
  } catch (e) {
    console.warn(
      `[quality-watchdog] provider creation failed (${provider}/${model}): ` +
        `${e instanceof Error ? e.message : String(e)} — watchdog disabled`,
    );
    setGlobalQualityWatchdog(null);
    return;
  }

  const runChat: WatchdogChatRunner = async ({ system, user, maxOutputTokens }) => {
    // The runner uses the AsyncIterable<ChatDelta> stream contract.
    // For the watchdog we only need the final text, so we consume the
    // stream and concatenate text deltas. No tools, no thinking.
    const stream = chatProvider.chat({
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      tools: [],
    });
    let text = '';
    for await (const delta of stream) {
      if (delta.type === 'text_delta') text += delta.text;
      if (maxOutputTokens && text.length > maxOutputTokens * 4) break;
    }
    return { text };
  };

  setGlobalQualityWatchdog(
    new QualityWatchdog({
      provider,
      model,
      runChat,
      prefilterCount: Number(process.env.MCP_QUALITY_WATCHDOG_PREFILTER_COUNT ?? 4),
      prefilterWindow: Number(process.env.MCP_QUALITY_WATCHDOG_PREFILTER_WINDOW ?? 5),
      cooldownTurns: Number(process.env.MCP_QUALITY_WATCHDOG_COOLDOWN_TURNS ?? 5),
    }),
  );
  console.log(`[quality-watchdog] wired (provider=${provider}, model=${model})`);
}

// ─── Company auto-resume (Phase 1 — metabolism at rest) ──────────────
//
// After a crash/restart/deploy every in-flight company session sits dormant
// until a human re-opens that exact session (orchestrators are lazy). These
// helpers re-arm, at boot, the sessions that have genuinely pending work — a
// subordinate message queued for the master — by constructing their
// orchestrator, which triggers `MasterInboxRouter.reviveIfPending` →
// `master.notify` → resurrect-from-saved-context.

/** Hard cap on sessions re-armed per boot (runaway backstop). */
const COMPANY_AUTORESUME_MAX = Math.max(0, Number(process.env.MCP_COMPANY_AUTORESUME_MAX ?? 25));
/** How many orchestrators to spawn in parallel during the sweep. */
const COMPANY_AUTORESUME_CONCURRENCY = Math.max(1, Number(process.env.MCP_COMPANY_AUTORESUME_CONCURRENCY ?? 3));
/** Delay before the sweep so it runs after the rest of boot wiring settles. */
const COMPANY_AUTORESUME_DELAY_MS = Math.max(0, Number(process.env.MCP_COMPANY_AUTORESUME_DELAY_MS ?? 3000));

/**
 * Auto-resume default: ON for server (node) deploys — the "always-on org"
 * posture — and OFF for desktop (electron) so launching the app doesn't
 * trigger a flood of worker spawns + master resurrects. `MCP_COMPANY_AUTORESUME`
 * overrides either way (`1`/`true` → on, `0`/`false` → off).
 */
function companyAutoResumeEnabled(): boolean {
  const v = process.env.MCP_COMPANY_AUTORESUME;
  if (v != null && v !== '') return v === '1' || v.toLowerCase() === 'true';
  return !process.versions.electron;
}

/**
 * Schedule a bounded, rate-limited, best-effort sweep that re-arms the given
 * sessions. Deferred via an unref'd timer so it never blocks boot and runs
 * after the worker doc/research deps are wired in `createApp`.
 */
function scheduleCompanyAutoResume(sessionIds: number[]): void {
  const ids = sessionIds.slice(0, COMPANY_AUTORESUME_MAX);
  const dropped = sessionIds.length - ids.length;
  const timer = setTimeout(() => {
    void (async () => {
      const { getOrSpawnCompanyOrchestrator } = await import('./sse/companyOrchestrator.js');
      let revived = 0;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          try {
            await getOrSpawnCompanyOrchestrator(id);
            revived++;
          } catch (e) {
            console.warn(
              `[company] auto-resume failed for session ${id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(COMPANY_AUTORESUME_CONCURRENCY, ids.length) }, worker),
      );
      console.log(
        `[company] Auto-resume: re-armed ${revived}/${ids.length} session(s) with pending master inbox` +
          (dropped > 0 ? ` (${dropped} over MCP_COMPANY_AUTORESUME_MAX skipped)` : ''),
      );
    })().catch((e) =>
      console.warn(`[company] auto-resume sweep failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, COMPANY_AUTORESUME_DELAY_MS);
  (timer as { unref?: () => void }).unref?.();
}

export function createApp() {
  // Settings bootstrap MUST run before anything else reads
  // `process.env.*`. The store reads every saved row from the DB and
  // copies it into `process.env`, so a `Number(process.env.MCP_API_PORT)`
  // read 200ms later sees the admin-chosen value instead of falling
  // through to the env / default chain. Safe to fail-open: a corrupt
  // settings table is logged + ignored so the http-api still boots.
  try {
    const { dbPath } = loadConfig();
    const settings = new AppSettingsStore(dbPath);
    const { applied } = settings.applyToProcessEnv();
    settings.close();
    if (applied > 0) {
      console.log(`[app-settings] applied ${applied} setting(s) from DB to process.env`);
    }
  } catch (e) {
    console.warn(
      `[app-settings] bootstrap failed (continuing with .env / defaults): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

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
  // db_* v2 tools — connections come from the SAME per-project-routed store
  // instances the routes/db-client handlers use (deps.dbClientFor), so the
  // agent always sees the rows the Databases tab shows. Session projects come
  // from CompanyStore (company_session_projects). The decryptor is resolved
  // LATE (per call) because Electron injects the real safeStorage decryptor
  // after createApp().
  setDbToolsStores(
    { listConnections: (projectId) => deps.dbClientFor(projectId).listConnections(projectId) },
    deps.companyStore,
  );
  setDbSecretDecryptor((blob) => getMainSecretDecryptor()(blob));
  // Install the global ToolSelectionPipeline filter. When
  // MCP_PIPELINES_TOOL_SELECTION is unset, buildToolSelectionFilter()
  // returns undefined and the global stays disabled — zero overhead.
  setGlobalToolSelectionFilter(deps.buildToolSelectionFilter());
  setGlobalToolSelectionOutcomeObserver(deps.observeToolSelectionOutcome);
  // Quality classifiers — pipeline already constructed in deps; we just
  // install it as the global and toggle it via env flag.
  setGlobalQualityClassifierPipeline(
    deps.qualityClassifierPipeline,
    process.env.MCP_PIPELINES_QUALITY_CLASSIFIERS === '1',
  );
  // Read side — the runner peeks at recent verdicts when building each
  // next system prompt (Wire #1 nudge, Wire #2 tool-misuse intervention).
  // Always installed; the runner short-circuits via the env flag.
  setGlobalQualityClassificationStore(deps.qualityClassificationStore);
  // Quality v2, C4 — Intervention store. Runner records every nudge /
  // planning intervention; global runner backfills the outcome when the
  // next classifier turn lands. Powers the "Intervention effectiveness"
  // dashboard panel.
  setGlobalQualityInterventionStore(deps.qualityInterventionStore);
  // Observer side — Wire #4 v2 aggregated alerts. Replaces the v1
  // per-flag spam with bucketed alerts that flush by threshold/interval
  // and then cooldown. Also widens coverage from off_topic-only to
  // off_topic + policy + tool_misuse (each in its own bucket).
  setGlobalQualityResultObserver(makeQualityAlertObserver());
  // Wire #5 (Nível 2) — Policy hard-block enforcer. Off by default;
  // operators opt in with MCP_PIPELINES_POLICY_HARD_BLOCK=1. The
  // regex pre-filter runs in microseconds — only the optional LLM
  // classifier path (gated by *_LLM=1) adds latency. We deliberately
  // keep the classifier path off by default to avoid 500ms-1s per
  // Bash call.
  if (process.env.MCP_PIPELINES_POLICY_HARD_BLOCK === '1') {
    setGlobalPolicyEnforcer(
      new PolicyEnforcer({
        useClassifier: process.env.MCP_PIPELINES_POLICY_HARD_BLOCK_LLM === '1',
      }),
    );
  } else {
    setGlobalPolicyEnforcer(undefined);
  }

  // Quality Watchdog — lightweight LLM that detects tool-loop / stuck
  // progress patterns. Gated by `MCP_QUALITY_WATCHDOG_ENABLED` (default
  // ON when provider+model are configured) so operators can disable.
  // Picks its own cheap model via `MCP_QUALITY_WATCHDOG_PROVIDER` and
  // `MCP_QUALITY_WATCHDOG_MODEL` (defaults to anthropic/claude-haiku-4-5)
  // so the main runner's tokens aren't spent on it.
  //
  // Fire-and-forget construction: provider creation is async (OAuth
  // shapes), so we kick it off in the background. If it fails, the
  // global stays null and the runner short-circuits — no behaviour
  // change vs. having the watchdog off.
  void wireQualityWatchdog().catch((e) => {
    console.warn(
      `[quality-watchdog] boot wiring failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
  // C8 — Inbox message watchdog (Sprint 3.5). Detects messages stuck
  // pending/delivered past the threshold and publishes
  // `inbox_message_stuck` events BEFORE the timeout fires EXPIRED.
  // Gated by MCP_COMPANY_INBOX_WATCHDOG_ENABLED=1. Publisher here is a
  // minimal logger — full per-session MetaBus integration is a
  // follow-up (multi-session bus aggregation isn't built yet).
  const inboxWatchdogPublisher: IMetaBusPublisher = {
    bus: undefined as unknown as IMetaBusPublisher['bus'],
    publish(event, payload): void {
      // Structured stderr log so external observers (admin dashboard,
      // ops scripts) can grep / parse.
      console.warn(`[inbox-watchdog] ${event} ${JSON.stringify(payload)}`);
    },
    markEnded(): void { /* watchdog never ends a run */ },
  };
  const inboxWatchdog: InboxMessageWatchdog | null = startInboxWatchdogIfEnabled({
    companyStore: deps.companyStore,
    publisher: inboxWatchdogPublisher,
  });
  if (inboxWatchdog) {
    console.log('[inbox-watchdog] started (MCP_COMPANY_INBOX_WATCHDOG_ENABLED=1)');
  }

  // AgentSupervisor: workers-only architecture means each company-worker
  // boots its own per-session supervisor inside the worker_thread (see
  // `apps/http-api/workers/company-worker.ts`). The main process holds
  // no supervisor instance — incidents flow from workers to main via
  // MessageBridge → SupervisorIncidentBus → SSE.
  // SubAgent result cache — installed unconditionally so even when the
  // flag is off, future toggles take effect immediately. Enable bit is
  // separate so the spawn handler can short-circuit before the lookup.
  setGlobalSubAgentCache(
    deps.subAgentResultCache,
    process.env.MCP_PIPELINES_SUB_AGENT_CACHE === '1',
  );
  setGlobalContextRelevancePipeline(
    deps.contextRelevancePipeline,
    process.env.MCP_PIPELINES_CONTEXT_RELEVANCE === '1',
  );
  setGlobalFeedbackCollector(deps.feedbackCollector);
  // (HotStateCache removed — bench showed SQLite p95 = 33 µs for
  // tail-polling reads, so the cache was net-negative. See
  // bench/results/hot-state-cache-baseline-2026-05-20.json.)
  setQaTestRunStore(deps.qaTestRunStore);
  setQaEndpointEnvStore(deps.companySessionEnvStore);
  // Design System is gated by DESIGN_SYSTEM_ENABLED (default ON). When off,
  // the store/skill-store stay un-wired AND the /api/design-system/* routes
  // are skipped below, so the whole module is dormant in one shot.
  if (deps.config.features.designSystemEnabled) {
    setDesignSystemStore(deps.designSystemStore);
    setDesignSystemSkillStore(deps.skillStore);
  }
  // App Studio store — wired for the app_* agent tools (same gate posture).
  if (deps.config.features.appStudioEnabled) {
    setAppStudioStore(deps.appStudioStore);
    setAppStudioDbClientStore({
      listConnections: (projectId) => deps.dbClientFor(projectId).listConnections(projectId),
      createConnection: (input) => deps.dbClientFor(input.project_id).createConnection(input),
      updateConnection: (projectId, id, patch) => deps.dbClientFor(projectId).updateConnection(id, patch),
    });
  }
  // API client (auto-test/auto-fix) store — wired for the `api_*` agent tools.
  setApiClientStore(deps.apiClientStore);
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
    // B7 — lets lifecycle transitions to stopped/error fail in-flight
    // QA runs fast with error_class='sidecar_down'.
    qaRunStore: deps.qaTestRunStore,
  });
  setChromeService(chromeService);
  // Hand the same ChromeService to the doc indexer's BrowserBackend so
  // bot-blocked fetches can escalate to Chromium via the existing WS
  // endpoint instead of spinning up a private browser per request.
  setChromeServiceForDocs(chromeService);

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

  // Register LLM providers contributed by enabled plugins. V1 providers ship
  // only ProviderSpec DATA; bundled V2 providers also expose a plugin-owned
  // adapter that loads lazily on use. Same reconcile the plugins handler runs
  // after every install/enable/disable, so the set stays live without a restart. NOTE: the
  // provider-resolving workers (coder/company) run the same reconcile at their
  // boot (see the worker entries) so the agent can resolve plugin providers too.
  try {
    syncPluginProviders();
  } catch (err) {
    console.warn(
      `[provider-plugin] load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Seed the offline hardcoded price table into model_prices (idempotent) and
  // hydrate the in-memory price cache so estimateCost() is accurate from the
  // first turn — even before any network price refresh has run.
  try {
    deps.providerStore.seedHardcodedModelPrices(hardcodedPriceSeed());
    mergeDBPricing(deps.providerStore.listAllModelPrices());
  } catch (e) {
    console.warn(`[pricing] DB hydration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Start background price refresh (OpenRouter + LiteLLM → model_prices),
  // reusing any configured OpenRouter credentials to dodge rate limits.
  {
    const or = deps.providerStore.listProviders().find((p) => p.kind === 'openrouter');
    startModelPricingRefreshScheduler(
      deps.providerStore,
      getEnabledPriceSources({
        openrouterApiKey: or?.api_key ?? undefined,
        openrouterBaseUrl: or?.base_url ?? undefined,
      }),
    );
  }

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

  // Same idea for individual coder sessions: any row left in an active
  // status after a restart belongs to a worker that no longer exists.
  // Flip them to `idle` so the dashboard renders the normal "send a
  // message" surface instead of a phantom in-flight run. Without this,
  // sessions hit by a silent worker death sat in `in_progress` forever
  // (the user couldn't engage them again — the UI thought a run was
  // still alive).
  try {
    const recovered = deps.sessionStore.recoverStaleSessions();
    if (recovered > 0) {
      console.log(`[coder] Startup recovery: ${recovered} coder_session(s) → idle`);
    }
  } catch (e) {
    console.warn(`[coder] Startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // GC orphan global-session virtual workspaces (synthetic union projects with
  // no session, + stray junction dirs) left by a crash or uncovered delete path.
  // SAFE: only unlinks junctions, never the real projects' files.
  try {
    const swept = sweepOrphanGlobalWorkspaces(deps);
    if (swept > 0) console.log(`[coder] Startup sweep: ${swept} orphan global workspace(s) cleaned`);
  } catch (e) {
    console.warn(`[coder] Global-workspace sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Frente E — periodic watchdog. The boot sweep above catches every
  // active session after a restart; this catches sessions that hang IN
  // FLIGHT (provider hang outside the dispatch timeout, MCP tool that
  // never resolves, etc.) without disturbing healthy in-progress runs.
  // The 10-minute stale threshold is well above any legitimate slow
  // turn — long compactions, big provider calls, even subagent batches
  // all complete well inside it. Synchronous import — the enclosing
  // function isn't async; dynamic import was the original bug.
  try {
    startCoderWatchdog({ sessionStore: deps.sessionStore });
  } catch (e) {
    console.warn(`[coder/watchdog] failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Idle memory sweeper — distills project memory from sessions that went
  // quiet (the moment most sessions actually "end"). Same lifecycle posture
  // as the watchdog: unref()-ed timer, best-effort, flag-gated
  // (MCP_MEMORY_SWEEPER=0 disables).
  // One-shot Agent Memory embedding back-fill — migrated/legacy rows (and any
  // saved while no embedding backend was configured) get their vectors so
  // semantic recall works, not just FTS. Best-effort, bounded, off the hot path.
  if (deps.agentMemoryService.hasEmbeddingBackend()) {
    void deps.agentMemoryService
      .backfillEmbeddings(undefined, 1000)
      .then((r) => {
        if (r.embedded > 0 || r.failed > 0) {
          console.log(`[memory] agent-memory embedding backfill — embedded=${r.embedded} failed=${r.failed}`);
        }
      })
      .catch((e) => console.warn(`[memory] backfill failed: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (memorySweeperEnabled()) {
    try {
      startMemorySweeper({
        sessionStore: deps.sessionStore,
        db: deps.db,
        runEndMemory: deps.runEndMemory,
      });
    } catch (e) {
      console.warn(`[memory/sweeper] failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Periodic memory consolidator — merges near-duplicate snapshots and GCs
  // stale/cold/low-importance ones (reversible archive). Always constructed so
  // the manual "run now" route works, but the periodic timer only arms when
  // MCP_MEMORY_CONSOLIDATE=1 (it archives rows, so it's explicit opt-in).
  try {
    startMemoryConsolidator({
      db: deps.db,
      snapshotService: deps.snapshotService,
      embeddingService: deps.embeddingService,
      armed: memoryConsolidateEnabled(),
    });
  } catch (e) {
    console.warn(`[memory/consolidator] failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Phase A "living company": surface any sessions that carry pending
  // master inbox messages from before the restart. Orchestrators are
  // lazy (built on first dashboard visit / stream reconnect), so the
  // actual drain happens via `MasterInboxRouter.reviveIfPending` in the
  // orchestrator constructor. This log just makes the operator aware so
  // they know which sessions still need someone to "look at them" to
  // wake the master.
  try {
    const sessionsWithPending = deps.companyStore.listSessionsWithPendingMasterInbox();
    if (sessionsWithPending.length > 0) {
      if (companyAutoResumeEnabled()) {
        // Auto-resume (metabolism at rest): proactively re-arm the dormant
        // sessions instead of just logging. Constructing each orchestrator
        // runs `MasterInboxRouter.reviveIfPending` in the worker boot, which
        // drains the queue and resurrects the master from its saved context
        // — no roleConfig rebuild needed. Deferred so it fires AFTER the
        // worker doc/research deps are wired (setCompanyWorkerDocDeps, below).
        scheduleCompanyAutoResume(sessionsWithPending);
      } else {
        console.log(
          `[company] Pending master inbox: ${sessionsWithPending.length} session(s) ` +
            `awaiting revive on next open — ids: ${sessionsWithPending.join(', ')} ` +
            `(auto-resume off; set MCP_COMPANY_AUTORESUME=1 to re-arm at boot)`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `[company] Master inbox scan failed: ${e instanceof Error ? e.message : String(e)}`,
    );
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

  // Documentação: any doc_sources row left in `fetching|indexing` after
  // a server restart is orphaned (the in-flight `IndexDocumentationUseCase`
  // didn't survive the process exit). Mark them `error` so the UI shows a
  // coherent state and the user can hit "Re-indexar".
  try {
    const { recovered } = deps.docStore.recoverStaleSources();
    if (recovered > 0) {
      console.log(`[doc-indexer] Boot: ${recovered} stale doc_source(s) → error`);
    }
  } catch (e) {
    console.warn(`[doc-indexer] Boot recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Best-effort drain of the vector tombstone retry queue (migration 088).
  // Tombstones accumulate when a DELETE source/collection couldn't reach
  // the remote vector store. This runs OFF the boot critical path via
  // `setImmediate` — failures don't block startup and any leftovers will
  // be retried on the next boot.
  setImmediate(() => {
    void deps.indexDocsUseCase.sweepTombstones(500)
      .then(({ drained, still_pending }) => {
        if (drained > 0 || still_pending > 0) {
          console.log(
            `[doc-indexer] Boot: drained ${drained} vector tombstone(s), ${still_pending} still pending`,
          );
        }
      })
      .catch((e) => {
        console.warn(
          `[doc-indexer] Boot tombstone sweep failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  });

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
  app.route('/api/admin', createMcpHttpStatusRouter(deps.config));
  app.route('/api/admin', createAppSettingsRouter(deps.config.dbPath));
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

    // Stack the localhost guard first, then auth. The guard refuses
    // off-loopback peers BEFORE we hash + look up a token, so a leaked
    // token outside the box still can't reach the tool catalogue.
    // (Operator can opt-in to LAN access via the admin section later.)
    const composed: import('hono').MiddlewareHandler = middleware
      ? async (c, next) =>
          localhostOnlyMiddleware()(c, async () => {
            await middleware(c, next);
          })
      : localhostOnlyMiddleware();

    const mcpApp = createMcpHttpApp(deps.config, {
      beforeTransport: composed,
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
  mountBuilderCheckpointRoutes(app, deps);
  mountProjectScaffoldRoute(app, deps);
  mountHygieneRoutes(app, deps);
  mountSearchRoutes(app, deps);
  mountFilesRoutes(app, deps);
  mountGraphRoutes(app, deps);
  mountSnapshotsRoutes(app, deps);
  mountMemoryDiagnosticsRoutes(app, deps);
  mountAgentMemoryRoutes(app, deps);
  mountUserMemoryRoutes(app, deps);
  mountRunsRoutes(app, deps);
  mountDiffRoutes(app, deps);
  mountCostsRoutes(app, deps);
  mountWebhooksRoutes(app, deps);
  mountExportRoutes(app, deps);
  mountModelsRoutes(app, deps);
  mountStatsRoutes(app, deps);
  mountTelemetryRoutes(app, deps);
  mountAdminPipelineBindingsRoutes(app, deps);
  mountAdminPipelineTelemetryRoutes(app, deps);
  mountAdminQualityRoutes(app, deps);
  mountAdminLshRoutes(app, deps);
  mountAdminDriftRoutes(app, deps);
  mountWorkersDiagnosticRoute(app);
  mountPerfRoutes(app);
  mountSupervisorAdminRoutes(app, { dbPath: deps.config.dbPath });
  app.route('/api/admin', createAdminRouter(deps.providerStore));
  mountCoderRoutes(app, deps);
  mountLspRoutes(app, deps);
  mountEditorRoutes(app, deps);
  mountProjectGitRoutes(app, deps);
  mountConfigRoutes(app, deps);
  // Design System Creator routes (sessions / versions / storybook proxy).
  // Mounted after coder routes so the company sessions referenced by
  // DS sessions are already wired. Gated by DESIGN_SYSTEM_ENABLED — when
  // off the routes are unmounted and the menu entry is hidden.
  if (deps.config.features.designSystemEnabled) {
    mountDesignSystemRoutes(app, deps);
  }
  // Sprite Studio routes (projects / assets / generation jobs / SSE). Gated
  // by SPRITE_STUDIO_ENABLED — when off the routes are unmounted and the
  // /sprites menu entry is hidden.
  if (deps.config.features.spriteStudioEnabled) {
    mountSpriteStudioRoutes(app, deps);
  }
  // App Studio routes (Code Studio para leigos — scaffold SSE + sessões +
  // pipeline). O gate APP_STUDIO_ENABLED vive dentro do mount.
  mountAppStudioRoutes(app, deps);
  mountWorkspaceRoutes(app, deps);
  // Self-hosted draw.io editor webapp — served at /drawio/* (mcp://app/drawio
  // in Electron). Static assets, no auth; the embedded editor for the diagram
  // capability loads from here. Degrades to a placeholder until vendored.
  mountDrawioStaticRoutes(app);
  // Phase D — terminal diagnose endpoint. Pre-flight HTTP check the
  // dashboard's terminal UI hits before opening the WS upgrade, so
  // gate rejections surface as structured JSON instead of an opaque
  // WebSocket close code 1006.
  mountTerminalDiagnoseRoute(app, { companyStore: deps.companyStore, db: deps.db });

  // Documentação (RAG) — global doc corpus + ingestion routes. Mounted
  // alongside its sibling tool wiring: `setGlobalDocSearch` installs the
  // backend the `rag_search_docs` agent tool reads from at call time, so
  // the moment routes are live, every agent in this process can search.
  mountDocsRoutes(app, deps);
  // Backend behind rag_search_docs / rag_read_doc — project scoping,
  // enhancement env-flags and the readChunk verb live in the builder
  // (server/docs/search-backend.ts).
  const docSearchBackend = buildDocSearchBackend({
    docHybridSearch: deps.docHybridSearch,
    docStore: deps.docStore,
  });
  setGlobalDocSearch(docSearchBackend);
  // <indexed-docs> per-turn hint — lists project-linked collections so
  // agents learn the corpus exists. Workers wire their own provider over
  // the worker-local DB (module globals don't cross worker_threads).
  setGlobalDocsHintProvider(buildDocsHintProvider(deps.docStore));

  // DocsAgent — multi-step retrieval orchestrator. Installed as a
  // process singleton so the (separately registered) docs_deep_research
  // tool can reach it from any in-process CoderRunner via
  // `getGlobalDocsResearcher()`.
  //
  // For worker-thread coders (MCP_CODER_WORKER=1), the singleton DOESN'T
  // propagate across `worker_threads` module boundaries — so we ALSO
  // wire the same backends into `setCoderWorkerDocDeps`. The worker
  // boot installs RPC shims that route `rag_search_docs` /
  // `docs_deep_research` calls back to THESE singletons via the
  // MessageBridge. Zero duplication, single source of truth.
  const docsResearchBridge = new DocsResearchBridge({
    db: deps.db.raw(),
    docStore: deps.docStore,
    docHybridSearch: deps.docHybridSearch,
    pipelineResolver: deps.pipelineProviderResolver,
  });
  setGlobalDocsResearcher(docsResearchBridge);

  // Vision fallback — image→text describer. Resolves the `code-agent/vision`
  // Pipelines role and runs a one-off chat so a model that can't see images
  // (or the composer "Describe images" flag) still gets an agent-directed
  // textual description. In-process coders read it via the global singleton;
  // worker coders reach it back over the MessageBridge (`vision` doc-dep below).
  const visionDescriber = createVisionDescriber({ resolver: deps.pipelineProviderResolver });
  setGlobalVisionDescriber(visionDescriber);

  // Sprite Studio host — the `sprite_*` agent tools reach it via the process
  // singleton (in-process coders) or the `spriteStudioHost` MessageBridge shim
  // (worker coders, wired into setCoderWorkerDocDeps below). Gated by the flag
  // so a build without the feature never wires it.
  const spriteStudioHost = deps.config.features.spriteStudioEnabled
    ? createSpriteStudioHostImpl(deps)
    : null;
  setGlobalSpriteStudioHost(spriteStudioHost);

  // Mem C across workers: memoryRetriever + runEndMemory are the SAME
  // canonical instances stream.ts passes on the in-process path — workers
  // reach them via the memoryRetrieve/memoryExtract/memoryIsConfigured RPC
  // handlers (sse/worker-memory-handlers.ts), so per-turn memory injection
  // and run-end distillation work identically with MCP_CODER_WORKER=1.
  setCoderWorkerDocDeps({
    docSearch: docSearchBackend,
    docsResearch: docsResearchBridge,
    vision: visionDescriber,
    // Sprite Studio host — worker coders reach it via the `spriteStudioHost.*`
    // RPC (shim in coder-worker.ts). Only the coder pool needs it: the sprite
    // tools register outside company context (mirroring DS Studio).
    spriteStudioHost,
    memoryRetriever: deps.memoryRetriever,
    memoryQuerySynthesizer: deps.memoryQuerySynthesizer,
    runEndMemory: deps.runEndMemory,
    projectMemory: deps.projectMemory,
  });
  // Same wire-up for the COMPANY worker pool — master + subordinates run
  // inside `company-worker.ts`, which installs the matching RPC shims. Without
  // this, `rag_search_docs` from a company subordinate errors with "doc corpus
  // backend is not wired into this process". Reuses the same backends.
  setCompanyWorkerDocDeps({
    docSearch: docSearchBackend,
    docsResearch: docsResearchBridge,
    vision: visionDescriber,
    // Role recommender for the autonomous CompanyScheduler — the SAME pipeline
    // the /recommend-role dashboard route uses (recommend-core.ts), so the
    // brain stays single-sourced.
    recommend: (input) => recommendRolesForSession(deps, input),
    memoryRetriever: deps.memoryRetriever,
    runEndMemory: deps.runEndMemory,
    projectMemory: deps.projectMemory,
  });
  mountDocsAgentRoutes(app, deps, docsResearchBridge);

  // Structural auto-index: upgrade the in-process executor to the dedicated
  // indexer worker_thread (scanner + tree-sitter + SQLite writes off the
  // main thread — in Electron the main thread IS the whole backend). Falls
  // back per-call to in-process on worker errors; no-op when the worker
  // entry can't resolve or MCP_INDEX_STRUCTURAL_WORKER=0. Single chokepoint
  // for BOTH modes — Electron main imports this same createApp().
  const indexerExecutorCfg = {
    ignorePatterns: deps.config.ignorePatterns,
    maxFileSizeKB: deps.config.maxFileSize,
    concurrency: deps.config.concurrency,
  };
  const indexer = createIndexerExecutor(
    { dbPath: deps.config.dbPath, ...indexerExecutorCfg },
    createInProcessStructuralExecutor(deps.db, indexerExecutorCfg),
  );
  deps.projectIndexService.setExecutor(indexer.executor);
  if (indexer.client) {
    const client = indexer.client;
    registerShutdownTask('indexer-worker-evict', () => client.dispose());
  }

  // LSP worker — the synchronous language compute (TS LanguageService +
  // index-fallback SQLite) moves off the main thread. Every consumer of
  // createLspHandlers (editor IPC, Hono fallback, agent adapter below)
  // dispatches through the module-singleton holder, so this single wiring
  // upgrades them all; with the worker unavailable the holder's executor
  // degrades per-call to the same in-process code as before.
  const lsp = createLspExecutor(
    { dbPath: deps.config.dbPath },
    createInProcessLspExecutor(deps.db),
  );
  setLspExecutor(lsp.executor);
  if (lsp.client) {
    const lspClient = lsp.client;
    registerShutdownTask('lsp-worker-evict', () => lspClient.dispose());
  }

  // Perf monitor sampler — feeds /api/admin/perf/*. Pool getters are
  // resolved lazily per tick (a pool that hasn't initialized yet just
  // contributes an empty list). `processMetricsProvider` is injected by
  // the Electron main process (app.getAppMetrics); null on web deploys.
  startPerfSampler({
    // Closure over `deps`, NOT the field value: Electron assigns
    // `deps.processMetricsProvider` only AFTER createApp() returns, so
    // capturing the value here would freeze it as undefined forever
    // (the panel would show the "web deploy" fallback inside Electron).
    processMetricsProvider: () => deps.processMetricsProvider?.() ?? null,
    companyMemStats: async () => {
      try { return await getWorkerOrchestratorPool().memStats(); } catch { return []; }
    },
    coderMemStats: async () => {
      if (!coderWorkerEnabled()) return [];
      try { return await getCoderWorkerPool().memStats(); } catch { return []; }
    },
    indexerMemStats: async () => indexer.client?.memStats() ?? null,
  });

  // Main-loop freeze watchdog — feeds /api/admin/perf/freezes. Detects real
  // event-loop stalls (whole-app "trava todas as telas") and attributes them
  // to the in-flight IPC handler. Cheap interval; unref'd.
  startFreezeWatchdog();

  // Agent LSP nav (lsp_definition/references/hover beyond TS) — ONE router
  // instance feeds three consumers: in-process coder runs (global backend),
  // worker bridges (deps box read by registerWorkerLspHandlers) and, via its
  // own handler instances, the editor. State is in module singletons, so the
  // extra createLspHandlers here shares buffers/manager with the editor's.
  const agentLsp = createLspHandlers(deps);
  setWorkerLspDeps({ handlers: agentLsp, db: deps.db });
  // Wire the LSP manager NOW (not lazily on first completion) so the
  // onDocEvent listener + status hub exist before the renderer's first
  // didOpen — closes the cold-start race that left the chip stuck blue.
  ensureLspManager(deps.db);

  // Perf-monitor ledger: LSP servers are separate OS processes spawned by
  // the manager — they do NOT show up in Electron's app.getAppMetrics(),
  // so we surface them here (count + ids) for the admin perf panel.
  getMemoryLedger().register('lsp.servers', async () => {
    const list = await agentLsp.instances(undefined, createContext());
    const rows = list as Array<{ projectId: number; serverId: string; state: string }>;
    return {
      count: rows.length,
      detail: rows.map((r) => `${r.serverId}#${r.projectId}(${r.state})`).join(', ') || 'nenhum server ativo',
    };
  });
  const resolveLspProjectId = (root: string, projectName: string): number | null =>
    deps.db.getProjectByPath(root)?.id ?? deps.db.getProjectByName(projectName)?.id ?? null;
  setGlobalAgentLspBackend({
    async definition({ root, projectName, file, position }) {
      const projectId = resolveLspProjectId(root, projectName);
      if (projectId == null) return null;
      return agentLsp.definition({ projectId, file, position }, createContext());
    },
    async references({ root, projectName, file, position }) {
      const projectId = resolveLspProjectId(root, projectName);
      if (projectId == null) return null;
      return agentLsp.references({ projectId, file, position }, createContext());
    },
    async hover({ root, projectName, file, position }) {
      const projectId = resolveLspProjectId(root, projectName);
      if (projectId == null) return null;
      return (await agentLsp.hover({ projectId, file, position }, createContext())) ?? null;
    },
  });

  // External-MCP connection pool. Boots async so the dashboard
  // starts serving immediately; the first chat session may pay a
  // small "no external tools" penalty if the boot hasn't finished,
  // but every subsequent session benefits from the pre-warmed
  // connections. Failures here don't bring the http-api down — we
  // log + continue. Coder worker pool picks the live reference via
  // `getMcpExternalPool` on each spawn.
  const mcpPool = new McpExternalPool({
    dbPath: deps.config.dbPath,
    bearerResolver: deps.mcpBearerResolver ?? null,
  });
  setCoderWorkerMcpPool(mcpPool);
  // Also publish via the in-process singleton so stream.ts (the
  // MCP_CODER_WORKER=off path) and `coder.stream.*` IPC handlers can
  // hand the pool to runCoder() too.
  setGlobalMcpExternalPool(mcpPool);
  void mcpPool
    .boot()
    .catch((e) => {
      console.warn(
        `[mcp-ext-pool] boot failed (continuing without pool): ${e instanceof Error ? e.message : String(e)}`,
      );
    });

  return { app, db: deps.db, chromeService, deps, mcpPool };
}

export async function startServer(port: number, host: string) {
  const [{ describeWorkerOrchestratorStatus }, { describeCoderWorkerStatus }] = await Promise.all([
    import('./sse/workerPoolSingleton.js'),
    import('./sse/coderWorkerPoolSingleton.js'),
  ]);
  // Workers-only architecture: company orchestrator MUST run in worker
  // threads. Refuse to boot if the worker file can't be resolved —
  // there's no in-process fallback path anymore.
  const company = describeWorkerOrchestratorStatus();
  if (!company.enabled) {
    console.error(
      `[fatal] Company worker pool unavailable: ${company.reason ?? 'unknown'}\n` +
      `Fix: run \`npm run build\` for production, or \`npm run dev:server\` / \`npm run electron:dev\` in development.`,
    );
    process.exit(1);
  }
  // Seed the first-party bundled provider plugins into the installed-plugins
  // store BEFORE createApp() runs syncPluginProviders, so they register on this
  // very boot. Idempotent + best-effort (built-ins remain if it fails).
  try {
    await seedBundledPlugins();
  } catch (err) {
    console.warn(`[bundled-plugins] seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { app, chromeService, deps } = createApp();
  console.log(`MCP Code Indexer API running at http://${host}:${port}`);
  const coder = describeCoderWorkerStatus();
  const fmtCompany = (s: { enabled: boolean; reason: string | null }): string =>
    s.enabled ? `ON (${s.reason ?? ''})` : `OFF — ${s.reason}`;
  const fmtCoder = (s: { enabled: boolean; envFlag: boolean; reason: string | null }): string => {
    if (s.enabled) return `ON (${s.reason ?? ''})`;
    if (s.envFlag) return `OFF — ${s.reason}`;
    return 'off';
  };
  console.log(`[workers] company orchestrator: ${fmtCompany(company)}`);
  console.log(`[workers] coder runs: ${fmtCoder(coder)}`);
  console.log(
    `[workers] diagnostics: GET ${host === '0.0.0.0' ? 'localhost' : host}:${port}/api/admin/workers`,
  );
  // `serve()` returns the underlying Node http.Server. We keep the
  // reference to attach the company stream WS upgrade — the dev-server
  // running inside the sandbox is now reached directly via its
  // loopback port (no MCP-side proxy / HMR upgrade rewriting).
  const server = serve({ fetch: app.fetch, port, hostname: host });
  // Node's http.Server default `requestTimeout` is 5 minutes (300_000
  // ms) since Node 18 — it destroys the underlying socket of any HTTP
  // request that's been open longer. That kills our SSE streams the
  // moment they cross the 5-min mark, which manifests as the agent
  // reporting "Os subagentes timed out após 300s" on long
  // `spawn_agents` runs in big codebases (the SSE connection dies
  // mid-stream → the worker's runner gets the abort).
  //
  // For an Electron-bundled IDE served on loopback we don't need the
  // slowloris-body protection that motivated Node's default — there's
  // no external attacker. Extend to 60 min and let power-users with
  // 10k+ file projects bump further via env. `headersTimeout` (1 min
  // default) stays — that protects the headers phase regardless of
  // body duration and the cost of preserving it is zero.
  const httpRequestTimeoutMs = Number(
    process.env.MCP_HTTP_REQUEST_TIMEOUT_MS ?? 60 * 60 * 1000,
  );
  (server as unknown as import('node:http').Server).requestTimeout =
    httpRequestTimeoutMs;
  // P14: parallel WebSocket transport for company sessions. Default
  // remains SSE; the dashboard opts in via `?transport=ws`.
  attachCompanyStreamUpgrade(server as unknown as import('node:http').Server);
  // Phase D: interactive terminal upgrade. Sandbox target wraps
  // `podman exec -it`; host target spawns the operator's local shell
  // (gated by MCP_HOST_TERMINAL_ENABLED=1).
  attachTerminalUpgrade(server as unknown as import('node:http').Server, {
    companyStore: deps.companyStore,
    db: deps.db,
  });

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
      const { disposeWorkerOrchestratorPool } = await import('./sse/workerPoolSingleton.js');
      const { disposeCoderWorkerPool } = await import('./sse/coderWorkerPoolSingleton.js');
      const { runShutdownTasks } = await import('./server/shutdown-tasks.js');
      const { disposeIndexerProcessResources } = await import('@mcp/indexer/bootstrap/dispose.js');
      await Promise.allSettled([
        closeDbWriter(),
        closeIndexJobPool(),
        disposeIndexerProcessResources(), // re-runs the two above (idempotent) + shared extractor
        runShutdownTasks(),               // registered disposables (ONNX sessions, …)
        disposeWorkerOrchestratorPool(),
        disposeCoderWorkerPool(),
      ]);
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
