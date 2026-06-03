import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { createAdminRouter } from './admin/index.js';
import { createDeps } from './server/deps.js';
import { mountProjectsRoutes } from './server/routes/projects.js';
import { mountProjectScaffoldRoute } from './server/routes/projects-scaffold.js';
import { mountHygieneRoutes } from './server/routes/hygiene.js';
import { mountSearchRoutes } from './server/routes/search.js';
import { mountFilesRoutes } from './server/routes/files.js';
import { mountGraphRoutes } from './server/routes/graph.js';
import { mountSnapshotsRoutes } from './server/routes/snapshots.js';
import { mountRunsRoutes } from './server/routes/runs.js';
import { mountTrainingRoutes } from './server/routes/training.js';
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
import { setDatabaseToolStores } from '@mcp/company/tools/database-tools.js';
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
import { DEFAULT_MIN_RELEVANCE } from '@mcp/services/services/docs/index.js';
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
import { startModelPricingRefreshScheduler } from '@mcp/indexer/indexer/providers/scheduled-pricing-refresh.js';
import { getEnabledPriceSources } from '@mcp/services/services/pricing/index.js';
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
import { mountDocsRoutes } from './server/routes/docs/index.js';
import { mountDocsAgentRoutes } from './server/routes/docs-agent/index.js';
import { setChromeServiceForDocs } from './server/deps.js';
import { setGlobalDocSearch } from '@mcp/code-agent/tools/rag-search-docs.js';
import { setGlobalVisionDescriber } from '@mcp/code-agent/core/vision-describer.js';
import { createVisionDescriber } from './server/vision-describer-impl.js';
import {
  DocsResearchBridge,
  setGlobalDocsResearcher,
} from '@mcp/docs-agent/bridges/docs-bridge.js';
import { setCoderWorkerDocDeps, setCoderWorkerMcpPool } from './sse/coderWorkerPoolSingleton.js';
import { setCompanyWorkerDocDeps } from './sse/workerPoolSingleton.js';
import { McpExternalPool, setGlobalMcpExternalPool } from './sse/McpExternalPool.js';
// Frente E — periodic watchdog for stuck coder_sessions. Started during
// server bootstrap below; auto-`unref()` so it never holds process exit.
import { startCoderWatchdog } from './sse/coder-watchdog.js';
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
  setDatabaseToolStores(deps.companySessionDatabaseStore, deps.companySessionEnvStore);
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
      console.log(
        `[company] Pending master inbox: ${sessionsWithPending.length} session(s) ` +
          `awaiting revive on next open — ids: ${sessionsWithPending.join(', ')}`,
      );
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
  mountProjectScaffoldRoute(app, deps);
  mountHygieneRoutes(app, deps);
  mountSearchRoutes(app, deps);
  mountFilesRoutes(app, deps);
  mountGraphRoutes(app, deps);
  mountSnapshotsRoutes(app, deps);
  mountRunsRoutes(app, deps);
  mountTrainingRoutes(app, deps);
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
  mountSupervisorAdminRoutes(app, { dbPath: deps.config.dbPath });
  app.route('/api/admin', createAdminRouter(deps.providerStore));
  mountCoderRoutes(app, deps);
  mountLspRoutes(app, deps);
  mountProjectGitRoutes(app, deps);
  mountConfigRoutes(app, deps);
  // Design System Creator routes (sessions / versions / storybook proxy).
  // Mounted after coder routes so the company sessions referenced by
  // DS sessions are already wired. Gated by DESIGN_SYSTEM_ENABLED — when
  // off the routes are unmounted and the menu entry is hidden.
  if (deps.config.features.designSystemEnabled) {
    mountDesignSystemRoutes(app, deps);
  }
  mountWorkspaceRoutes(app, deps);
  // Phase D — terminal diagnose endpoint. Pre-flight HTTP check the
  // dashboard's TerminalPanel hits before opening the WS upgrade, so
  // gate rejections surface as structured JSON instead of an opaque
  // WebSocket close code 1006.
  mountTerminalDiagnoseRoute(app, { companyStore: deps.companyStore, db: deps.db });

  // Documentação (RAG) — global doc corpus + ingestion routes. Mounted
  // alongside its sibling tool wiring: `setGlobalDocSearch` installs the
  // backend the `rag_search_docs` agent tool reads from at call time, so
  // the moment routes are live, every agent in this process can search.
  mountDocsRoutes(app, deps);
  // Env-flag-aware adapter — the tool interface (DocSearchBackend in
  // packages/code-agent) only exposes {query,collection,limit}, so the
  // enhancements (rewrite + rerank) + relevance threshold live in this
  // wrapper. They default ON so the first-line `rag_search_docs` every
  // agent reaches for gets calibrated relevance and an honest "no good
  // match" without opting in. Set the env var to '0' to disable.
  //   DOCS_RAG_REWRITE=0  → query rewriter OFF
  //   DOCS_RAG_RERANK=0   → reranker OFF (also disables calibrated scores)
  // Both still degrade to no-op when the corresponding binding is
  // unconfigured in the admin panel — flags only control the OPT-IN.
  const docsRagRewrite = process.env.DOCS_RAG_REWRITE !== '0';
  const docsRagRerank = process.env.DOCS_RAG_RERANK !== '0';
  const docSearchBackend = {
    search: async (input: Parameters<typeof deps.docHybridSearch.search>[0]) => {
      return deps.docHybridSearch.search({
        // Threshold weak hits so the tool can report "nothing relevant"
        // instead of citing junk. Only bites when rerank produced
        // calibrated scores; a caller-supplied value still wins.
        min_relevance: DEFAULT_MIN_RELEVANCE,
        ...input,
        enhancements: { rewrite: docsRagRewrite, rerank: docsRagRerank },
      });
    },
  };
  setGlobalDocSearch(docSearchBackend);

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

  setCoderWorkerDocDeps({ docSearch: docSearchBackend, docsResearch: docsResearchBridge, vision: visionDescriber });
  // Same wire-up for the COMPANY worker pool — master + subordinates run
  // inside `company-worker.ts`, which installs the matching RPC shims. Without
  // this, `rag_search_docs` from a company subordinate errors with "doc corpus
  // backend is not wired into this process". Reuses the same backends.
  setCompanyWorkerDocDeps({ docSearch: docSearchBackend, docsResearch: docsResearchBridge, vision: visionDescriber });
  mountDocsAgentRoutes(app, deps, docsResearchBridge);

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
      await Promise.allSettled([
        closeDbWriter(),
        closeIndexJobPool(),
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
