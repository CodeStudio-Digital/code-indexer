import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { CodeIndexDB } from '@mcp/store/db.js';
import { getDbWriter, isDbWriterEnabled, type DbWriter } from '@mcp/indexer/workers/dbWriter/client.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { ChatProvider, CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { PermissionGate, normalizeToolPermissionMode } from '@mcp/code-agent/core/permission-gate.js';
import { summarizeSpanV2, renderSummaryV2 } from '@mcp/code-agent/core/summarizer.js';
import { runDurableCompaction } from '@mcp/code-agent/core/runner/compaction/durable-compaction.js';
import { durableCompactionEnabled } from '@mcp/code-agent/core/runner/compaction/threshold.js';
import { getGlobalToolSelectionFilter } from '@mcp/code-agent/tool-selection/global-filter.js';
import { buildSystemPrompt } from '@mcp/code-agent/core/system-prompt.js';
import { buildRepoMap, resolveRepoMapBudget } from '@mcp/code-agent/core/repo-map.js';
import { workspaceFromProject, type WorkspaceContext } from '@mcp/code-agent/core/workspace.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitTools } from '@mcp/code-agent/tools/git.js';
import {
  defaultLocalFilesystemPort,
  defaultLocalShellPort,
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from '@mcp/code-agent/ports/index.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';
import { SessionFileReviewStore } from '@mcp/store/session-file-review-store.js';
import { SandboxFilesystemAdapter } from '@mcp/services/sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '@mcp/services/sandbox/adapters/sandbox-shell-adapter.js';
import { planTools } from '@mcp/code-agent/tools/plan.js';
import { specTools } from '@mcp/code-agent/tools/spec/index.js';
import {
  tasksTools,
  listTasks,
  cancelTasks,
  deleteTasks,
  archiveTaskList,
  // Frente D — `executeTask` (singular) removed: `execute_tasks` (plural,
  // wave-based) is the single orchestration entry point. `taskComplete`
  // stays because inline-mode scope closure inside `execute_tasks` still
  // depends on it (the agent's "I finished this inline turn" signal).
  taskComplete,
  updateTask,
} from '@mcp/code-agent/tools/tasks.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { buildExpandTools } from '@mcp/code-agent/tools/expand.js';
import { buildFindToolsTool } from '@mcp/code-agent/tools/find-tools.js';
import { buildRequestReviewTool } from '@mcp/code-agent/tools/request-review.js';
import { buildSelfReviewTool } from '@mcp/code-agent/tools/self-review.js';
import { McpToolBridge } from '@mcp/code-agent/tools/mcp-bridge.js';
import { buildMcpResourceTools } from '@mcp/code-agent/tools/mcp-resources.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { buildSpawnAgentTool } from '@mcp/code-agent/tools/spawn-agent.js';
import { loadPrompt, interpolate } from '@mcp/code-agent/prompts/loader.js';
import { parseDsConsumer, parseDsWorkspace } from '@mcp/code-agent/core/builder-config.js';
import { buildDsConsumerBlock } from '@mcp/code-agent/core/ds-consumer-prompt.js';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';
import { buildKanbanTools } from '@mcp/company/tools/kanban-tools.js';
import { buildBoardTools } from '@mcp/company/tools/board-tools.js';
import { buildQaTools } from '@mcp/company/tools/qa/index.js';
import { buildDesignSystemStudioTools, buildDesignSystemConsumerTools } from '@mcp/company/tools/design-system/index.js';
import { buildSubordinateTools } from '@mcp/company/tools/subordinate-tools.js';
import { buildSharedDriveTools } from '@mcp/company/tools/shared-drive-tools.js';
import { sandboxTools } from '@mcp/company/tools/sandbox-tools.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import { envTools } from '@mcp/company/tools/env-tools.js';
import { databaseTools } from '@mcp/company/tools/database-tools.js';
import { buildSubordinateKanbanTools } from '@mcp/company/tools/subordinate-kanban-tools.js';
import { isMasterAllowed } from '@mcp/company/tools/master-filter.js';
import { RuntimeHookRegistry } from '@mcp/code-agent/core/hook-registry.js';
import { registerCompanyHooks } from '@mcp/code-agent/core/company-hooks.js';
import { inferProfileFromMessage, inferProfileFromHistory, profileToTiers, type CoderProfile } from '@mcp/code-agent/tools/tiers.js';
import { AGENTS, isAgentId, type AgentId } from '@mcp/code-agent/agents/index.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { ToolOutputStore } from '@mcp/code-agent/overlay/tool-output-store.js';
import { toolOutputTools } from '@mcp/code-agent/tools/tool-output.js';
import { diagnosticsTools } from '@mcp/code-agent/tools/diagnostics.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { httpTools } from '@mcp/code-agent/tools/http.js';
import { globTools } from '@mcp/code-agent/tools/glob.js';
import { ragSearchDocsTools } from '@mcp/code-agent/tools/rag-search-docs.js';
import { todoTools, generateTodoId } from '@mcp/code-agent/tools/todo.js';
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { buildSessionDriveTools } from '@mcp/code-agent/tools/session-drive-tools.js';
import { getInvestigationEmbedder } from '@mcp/code-agent/tools/investigation-embedder.js';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import { listAgentsTools } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgentsTools } from '@mcp/code-agent/tools/wait-agents.js';
import { sendMessageTools } from '@mcp/code-agent/tools/send-message.js';
import { sendInputTools } from '@mcp/code-agent/tools/send-input.js';
import { followupTaskTools } from '@mcp/code-agent/tools/followup-task.js';
import { worktreeTools, createProjectWorktree } from '@mcp/code-agent/tools/worktree.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import type { ResolvedSkill, SkillTemplateContext } from '@mcp/code-agent/skills/types.js';
import { buildInvokeSkillTool, buildSkillDiscoveryTools } from '@mcp/code-agent/skills/skill-tool-builder.js';
import { buildCreateSkillTool } from '@mcp/code-agent/tools/create-skill.js';
import { listInstalledNamespaces } from '@mcp/code-agent/skills/agent-skills-installer.js';
import {
  buildCompactSkillsSection,
  buildLazySkillsSection,
  buildMatchedSkillsPromptSection,
  buildSkillsPromptSection,
} from '@mcp/code-agent/skills/prompt-injector.js';
import { matchSkills, type SkillMatchContext } from '@mcp/code-agent/skills/skill-matcher.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';
import { attachmentsToBlocks, type AgentMessage, type ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

// Public types live in ./index/types.ts (extracted to keep this file under
// the LOC cap). Re-exported below so external consumers of @mcp/code-agent
// continue to see them on the package root.
import type {
  CoderAttachment,
  IndexStatus,
  MasterStartResult,
  RunCoderHandle,
  RunCoderOptions,
} from './index/types.js';
export type { CoderAttachment, IndexStatus, MasterStartResult, RunCoderHandle, RunCoderOptions };
import { extractFilePathsFromText, defaultModelFor } from './index/helpers.js';

// (Type bodies moved to './index/types.ts'.)

/**
 * Module-level lazy singleton for the incremental indexer.
 *
 * Why a singleton and not a static import?
 *   - `@mcp/indexer/indexer/incremental` instantiates a `TreeSitterExtractor`
 *     and `initTreeSitter()` (WASM load) at module-eval time.
 *   - Sessions that never edit code (plan-mode / pure investigation)
 *     should pay ZERO of that cost.
 *
 * Why a singleton and not `await import(...)` in the hook?
 *   - The hook fires on every successful mutating tool call. Without
 *     memoisation each call creates an extra Promise + microtask, even
 *     though ESM caches the actual module after the first load.
 *   - Promise.all-style concurrent edits in the same turn would also
 *     trigger N parallel resolutions; the singleton dedupes them.
 *
 * Cached as a Promise (not the resolved function) so concurrent first-
 * callers race on the SAME load instead of starting two of them.
 */
let incrementalIndexerPromise:
  | Promise<typeof import('@mcp/indexer/indexer/incremental.js').indexFileNow>
  | null = null;
function loadIncrementalIndexer(): Promise<
  typeof import('@mcp/indexer/indexer/incremental.js').indexFileNow
> {
  if (!incrementalIndexerPromise) {
    incrementalIndexerPromise = import('@mcp/indexer/indexer/incremental.js')
      .then((mod) => mod.indexFileNow);
  }
  return incrementalIndexerPromise;
}

/**
 * Build a fully-wired runner for a coder session and start it.
 *
 * Both the CLI and the SSE handler use this. Listeners should be attached
 * to `handle.runner` BEFORE awaiting `handle.done`.
 */
export async function runCoder(opts: RunCoderOptions): Promise<RunCoderHandle> {
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const store = new SessionStore(config.dbPath);
  const dbWriter: DbWriter | null = isDbWriterEnabled() ? getDbWriter(config.dbPath) : null;

  // Resolve or create the session. `agent` is persisted on the session row so
  // resume paths (/continue, reattach) honour the user's preset even when the
  // request body doesn't re-send it.
  let session: CoderSession;
  if ('id' in opts.session) {
    const found = store.getSession(opts.session.id);
    if (!found) throw new Error(`Session ${opts.session.id} not found`);
    session = found;
  } else {
    session = store.createSession({
      project_id: opts.session.create.project_id,
      title: opts.session.create.title,
      provider: opts.session.create.provider,
      model: opts.session.create.model ?? defaultModelFor(opts.session.create.provider),
      agent: opts.agent ?? null,
    });
  }

  // Sticky agent: if the caller didn't specify one, fall back to the value
  // stored on the session. If they did and it differs, persist the new choice.
  const storedAgent: AgentId | null =
    session.agent && isAgentId(session.agent) ? session.agent : null;
  const effectiveAgentId: AgentId | null = opts.agent ?? storedAgent;
  if (opts.agent && opts.agent !== storedAgent) {
    store.setSessionAgent(session.id, opts.agent);
    session = { ...session, agent: opts.agent };
  }

  // Apply agent defaults for any unspecified knob. This way explicit opts win
  // over presets (e.g. `--agent build --plan` keeps plan mode on), but resume
  // requests with no opts still inherit the preset's profile/planMode.
  const agentDef = effectiveAgentId ? AGENTS[effectiveAgentId] : null;
  if (agentDef) {
    if (opts.profile === undefined) opts = { ...opts, profile: agentDef.profile };
    if (opts.planMode === undefined) opts = { ...opts, planMode: agentDef.planMode };
    if (opts.maxTurns === undefined && agentDef.maxTurns) opts = { ...opts, maxTurns: agentDef.maxTurns };
  }

  const project = db.getProject(session.project_id);
  if (!project) throw new Error(`Project ${session.project_id} not found`);

  // For google-oauth sessions, ensure a persistent CloudCode session ID exists.
  let cloudCodeSessionId: string | undefined;
  if (session.provider === 'google-oauth') {
    cloudCodeSessionId = store.getOrCreateCloudCodeSessionId(session.id);
  }

  // Provider — async path so Copilot tokens get refreshed before the run.
  const provider = await createCoderProvider(
    session.provider,
    session.model,
    cloudCodeSessionId ? { cloudCodeSessionId } : undefined,
  );

  // Session overlay — tracks files touched this run so MCP read tools
  // serve fresh disk data without re-indexing.
  const overlay = new SessionOverlay(resolvePath(project.root_path));
  // Side-file store for truncated tool outputs — enables `get_tool_output`.
  const toolOutputStore = new ToolOutputStore(resolvePath(project.root_path), session.id);

  // Tool registry: native tools + bridged MCP tools
  const registry = new ToolRegistry();
  registry.registerAll(fsTools);
  registry.registerAll(shellTools);
  registry.registerAll(gitTools);
  // apply_patch is registered for ALL providers. For ChatGPT/Codex with
  // `apply_patch_tool_type === 'freeform'`, the chatgpt provider rewrites
  // the wire shape to `type: 'custom'` (raw patch text, no JSON escaping).
  // For everyone else (Claude, Gemini, etc.) it stays a regular function
  // tool with a single `patch: string` param — the model emits JSON-
  // escaped patch text and the handler parses it. Costs ~600 extra chars
  // in the system prompt vs gating, but pays off on multi-file edits where
  // a single deterministic patch beats N rounds of edit_file/multi_edit.
  registry.register(applyPatchTool);

  // Company subordinates get master-directed communication tools instead of
  // the human-facing ask_user / submit_plan / submit_tasks. The replacement
  // tools emit the same runner events so orchestrator interception is unchanged.
  if (opts.companyContext && !opts.companyContext.isMaster) {
    registry.registerAll(buildSubordinateTools());
    registry.register(listTasks);
    registry.register(cancelTasks);
    registry.register(deleteTasks);
    registry.register(archiveTaskList);
    // Frente D — drop `execute_task` (singular). The orchestrator
    // `execute_tasks` (plural) covers every dispatch path; the model has
    // no remaining reason to call the per-task entry point.
    registry.register(taskComplete);
    registry.register(updateTask);
  } else {
    registry.registerAll(planTools);
    registry.registerAll(specTools);
    registry.registerAll(tasksTools);
    registry.registerAll(interactionTools);
  }
  // Env tools manage session-shared env vars stored in the DB
  // (`company_session_envs`). They work with NO container alive, so they are
  // registered for EVERY company session — master + subordinates — not just
  // builder/sandbox ones. A session can define shared envs (BACKEND_URL,
  // JWT_TOKEN, …) while targeting an EXTERNAL backend with no builderStack;
  // gating these behind sandbox/builderStack hid them from `find_tools`, so
  // the master had to relay env values to subordinates by hand. The master
  // filter (`filterInPlace(isMasterAllowed)` below) trims the master to the
  // read-only trio (env_list/env_read/env_validate); subordinates keep all 5.
  if (opts.companyContext) {
    registry.registerAll(envTools);
  }
  // Builder-mode tools: offered to both master and subordinates in builder
  // sessions. The gate is on session configuration (`builderStack`) rather
  // than a live sandbox binding so the master can access database tools
  // even when the primary container is temporarily unavailable.
  // Tools that actually need a live container (sandboxTools, docsTools) are
  // still registered — they will return clear errors if called without one.
  if (opts.companyContext?.sandbox || opts.companyContext?.builderStack) {
    registry.registerAll(sandboxTools);
    // Docs tools write into `<workdir>/docs/` inside the container.
    // Registered for all builder sessions; fail gracefully when the
    // container is down so the agent gets a useful error message.
    registry.registerAll(docsTools);
    // Database tools query Postgres/MySQL instances registered in the
    // Databases tab — DB-backed, do not require the sandbox container.
    registry.registerAll(databaseTools);
  }
  // expand_toolset registered AFTER external MCP servers (see below) so its
  // tier enum can include custom tiers dynamically.
  registry.registerAll(toolOutputTools);
  registry.registerAll(diagnosticsTools);
  registry.registerAll(lspTools);
  registry.registerAll(execCommandTools);
  registry.registerAll(webTools);
  registry.registerAll(httpTools);
  registry.registerAll(globTools);
  registry.registerAll(ragSearchDocsTools);
  registry.registerAll(todoTools);
  registry.registerAll(viewImageTools);
  registry.registerAll(previewTools);
  registry.registerAll(goalTools);
  // Session Drive — single-session working memory (read_plan / remember /
  // list_memory / recall_investigations). Only outside company context:
  // company sessions have the shared drive + board instead, and the tools
  // need `ctx.sessionDrive` which is wired below for real (non-company)
  // sessions. Bootstrap-tier (see tools/tiers.ts) so any mode can use them.
  if (!opts.companyContext) {
    registry.registerAll(buildSessionDriveTools());
  }
  // DS Studio — single sessions on a Design System workspace project get
  // the ds_* tools (record/list/audit/publish) bound to the project. The
  // workspace is identified by `projects.builder_json.kind === 'ds'`
  // (written by the studio scaffold). Company sessions keep their own
  // registration below; the feature flag gates the whole surface.
  const dsWorkspace = !opts.companyContext ? parseDsWorkspace(project.builder_json) : null;
  if (dsWorkspace && config.features.designSystemEnabled) {
    registry.registerAll(buildDesignSystemStudioTools(project.id));
  }
  // DS CONSUMER — a builder project linked to a PUBLISHED design system
  // (`builder_json.designSystem`, written by the link flow) gets read-only
  // query tools (ds_components/ds_component/ds_docs) so the agent uses the
  // library instead of guessing props. Mutually exclusive with the studio
  // workspace above (parseDsConsumer returns null when kind==='ds').
  const dsConsumer = !opts.companyContext && !dsWorkspace ? parseDsConsumer(project.builder_json) : null;
  if (dsConsumer && config.features.designSystemEnabled) {
    registry.registerAll(buildDesignSystemConsumerTools(dsConsumer));
  }
  // Cross-agent comm tools (list_agents / wait_agents / send_message /
  // send_input / followup_task) were registered here UNCONDITIONALLY, so they
  // fell through getToolTier → bootstrap and shipped on turn 1 of every SOLO
  // session — where each errors or returns just-self (no peer to reach). Moved
  // into the `if (opts.companyContext)` block below (P1) so solo prompts drop
  // them entirely. Master/subordinate sessions are unaffected.
  // code_exec — registered last in the native batch so its tools-proxy
  // closes over a registry that already includes fs/git/web/lsp/glob/etc.
  // The proxy itself is rebuilt per invocation (`registry.list()` at call
  // time), so MCP/company tools added later are also picked up.
  registry.register(buildCodeExecTool(registry));
  registry.registerAll(worktreeTools);

  // MCP bridges — Master gets N bridges (one per company project, prefixed tools),
  // subordinates and regular sessions get a single bridge.
  const bridge = new McpToolBridge();
  const extraBridges: McpToolBridge[] = [];
  let mcpBridgeOk = false;

  if (opts.companyContext?.isMaster) {
    // Master: register prefixed MCP tools for ALL company projects
    const companyProjects = opts.companyContext.orchestrator.listProjects();
    for (const proj of companyProjects) {
      const projBridge = new McpToolBridge();
      try {
        await projBridge.connect();
        const slug = proj.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        const projOverlay = new SessionOverlay(resolvePath(proj.rootPath));
        const mcpTools = await projBridge.listTools({ projectName: proj.name, overlay: projOverlay });
        // Rename: mcp__read_file → mcp__{slug}__read_file
        const prefixed = mcpTools.map((t) => ({
          ...t,
          name: `mcp__${slug}__${t.name.replace(/^mcp__/, '')}`,
        }));
        registry.registerAll(prefixed);
        extraBridges.push(projBridge);
        console.log(`[coder] Master: ${prefixed.length} MCP tools for project ${proj.name} (prefix: mcp__${slug}__*)`);
      } catch (e) {
        console.warn(`[coder] MCP bridge for ${proj.name} failed: ${e instanceof Error ? e.message : String(e)}`);
        await projBridge.close();
      }
    }
    mcpBridgeOk = extraBridges.length > 0;
  } else {
    // Regular session / subordinate: single bridge
    try {
      await bridge.connect();
      const mcpTools = await bridge.listTools({ projectName: project.name, overlay });
      registry.registerAll(mcpTools);
      // Resource discovery/read tools — companion to the bridged tools.
      // Cheap to expose: handlers no-op when the server publishes nothing.
      registry.registerAll(buildMcpResourceTools(bridge));
      mcpBridgeOk = mcpTools.length > 0;
    } catch (e) {
      console.warn(`[coder] MCP bridge failed to connect: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // External MCP servers — configured via admin panel (migration 015).
  // Connected AFTER internal bridge so external tools are at the tail of the
  // registry, meaning they are trimmed first when the model tool cap kicks in.
  //
  // Prefer the caller-provided manager (typically the http-api's pool-backed
  // `RemoteMcpServerManager`) so we don't reopen transports per run. Fall back
  // to a local `McpServerManager` for CLI / test usage where there's no pool.
  const mcpServerManager: import('@mcp/code-agent/tools/mcp-server-manager-interface.js').IMcpServerManager =
    opts.externalMcpManager ?? new McpServerManager(opts.mcpBearerResolver ?? null);
  let externalToolTiers: ReadonlyMap<string, import('@mcp/code-agent/tools/tiers.js').ToolTier> | undefined;
  // Subordinate-only override: turns each connected MCP server into its own
  // expandable custom tier (named by server id) so the agent sees the pack
  // in the system prompt and unlocks it on demand via expand_toolset, instead
  // of the admin's `default_tier` deciding visibility per-server.
  let subordinateTierSummary: Map<string, { displayName: string; toolCount: number }> | undefined;
  const isSubordinate = !!opts.companyContext && !opts.companyContext.isMaster;
  try {
    const mcpServerStore = new McpServerStore(config.dbPath);
    const enabledServers = mcpServerStore.listServers({ enabled: true });
    if (enabledServers.length > 0) {
      await mcpServerManager.connectAll(enabledServers);
      const { tools: extTools, tierMap } = await mcpServerManager.listAllTools();
      if (extTools.length > 0) {
        registry.registerAll(extTools);
        externalToolTiers = tierMap;
        // Cache discovered tools in DB so admin/session panels see them instantly
        for (const srv of enabledServers) {
          const prefix = `ext_${srv.id}__`;
          const srvTools = extTools
            .filter((t) => t.name.startsWith(prefix))
            .map((t) => ({ name: t.name.slice(prefix.length), description: t.description }));
          if (srvTools.length > 0) mcpServerStore.replaceServerTools(srv.id, srvTools);
        }
        console.log(
          `[coder] ${extTools.length} external tool(s) from ${mcpServerManager.connectedCount} MCP server(s)`,
        );

        if (isSubordinate) {
          const subTierMap = new Map<string, import('@mcp/code-agent/tools/tiers.js').ToolTier>();
          subordinateTierSummary = new Map();
          for (const srv of enabledServers) {
            const prefix = `ext_${srv.id}__`;
            const srvToolNames = extTools.filter((t) => t.name.startsWith(prefix)).map((t) => t.name);
            if (srvToolNames.length === 0) continue;
            for (const n of srvToolNames) subTierMap.set(n, srv.id);
            subordinateTierSummary.set(srv.id, { displayName: srv.name, toolCount: srvToolNames.length });
          }
          externalToolTiers = subTierMap;
          if (subordinateTierSummary.size > 0) {
            console.log(
              `[coder] subordinate ${opts.companyContext!.agentRole}: external MCPs as opt-in tiers ` +
                `[${[...subordinateTierSummary.keys()].join(', ')}] — call expand_toolset to unlock`,
            );
          }
        }
      }
    }
    mcpServerStore.close();
  } catch (e) {
    console.warn(`[coder] External MCP servers failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Plugin tools — contributed by installed plugins, with worker-backed
  // handlers synthesized by the http-api layer (@mcp/plugin-host
  // buildPluginTools). Registered at the tail like external MCP tools, so
  // they're trimmed first under the model tool cap. Dormant in CLI/tests.
  if (opts.pluginTools?.length) {
    registry.registerAll(opts.pluginTools);
  }

  // expand_toolset — registered AFTER external servers so the tier enum
  // includes any custom tiers (e.g., "cloudflare", "github") from connected servers.
  // For subordinates, every enabled MCP server is exposed as its own opt-in tier
  // (regardless of admin's `default_tier`) so the master/session-free behavior
  // (which respects the configured tier) is preserved.
  const customTierSummary = subordinateTierSummary ?? mcpServerManager.getCustomTierSummary();
  registry.registerAll(buildExpandTools(customTierSummary.size > 0 ? customTierSummary : undefined));

  // find_tools — Camada 3 lazy discovery. Always registered (cheap, read-only,
  // no tier promotion). Belongs in bootstrap so it's visible before the agent
  // has unlocked anything else. Implementation lives in find-tools.ts.
  registry.registerAll([buildFindToolsTool(registry)]);

  // request_review — Camada 4 reviewer subagent. Registered with a placeholder
  // tool snapshot; the runner snapshots the registry AFTER all tools are
  // registered so the reviewer's REVIEW_ALLOWLIST resolves correctly. The
  // reviewerProvider falls back to the parent provider when subagentTarget
  // hasn't been configured (legacy single-family behaviour).
  registry.registerAll([
    buildRequestReviewTool({
      provider,
      parentTools: registry.list(),
      sessionId: session.id,
      sessionStore: store,
      // Reuse the subagent provider plumbing: when an admin has set a
      // different family for subagents (subagentTarget), use it for review.
      reviewerProvider: undefined, // wired at run-time via subagentProvider in subagent.ts
    }),
  ]);

  // Load disabled tools early so the subagent parentTools snapshot is already
  // filtered. Must happen before registry.list() is captured below.
  let globalDisabledTools: ReadonlySet<string> | undefined;
  try {
    const ps = new ProviderStore(config.dbPath);
    const disabled = ps.listGlobalDisabledTools();
    ps.close();
    if (disabled.length > 0) globalDisabledTools = new Set(disabled);
  } catch {
    /* table may not exist yet — no-op */
  }
  const sessionDisabledTools = store.getSessionDisabledTools(session.id);

  // Subagent deps — built AFTER MCP tools so it captures the full tool list
  // for filtering. Disabled via CODER_DISABLE_SUBAGENTS=1. Also DISABLED for
  // company Master (it must use spawn_subordinate_agent instead — ephemeral
  // subagents don't fit the orchestration role).
  let subagentDeps: SubagentDeps | null = null;
  if (process.env.CODER_DISABLE_SUBAGENTS !== '1' && !opts.companyContext?.isMaster) {
    const allDisabled = new Set([...(globalDisabledTools ?? []), ...sessionDisabledTools]);
    const parentTools = allDisabled.size > 0
      ? registry.list().filter((t) => !allDisabled.has(t.name))
      : registry.list();
    let subagentProvider: ChatProvider | undefined;
    try {
      const ps = new ProviderStore(config.dbPath);
      const subagentTarget = ps.getSubagentTarget(session.provider);
      ps.close();
      const targetProviderId = subagentTarget?.providerId ?? session.provider;
      const targetModel = subagentTarget?.modelId ?? undefined;
      const usesDifferentProvider = targetProviderId !== session.provider;
      const usesDifferentModel = !!targetModel && targetModel !== session.model;
      if (usesDifferentProvider || usesDifferentModel) {
        const sub = await createCoderProvider(targetProviderId, targetModel);
        subagentProvider = sub;
        console.log(`[coder] subagent provider override: ${targetProviderId}:${sub.model}`);
      }
    } catch { /* non-fatal — falls back to parent provider */ }

    subagentDeps = { provider, parentTools, sessionStore: store, subagentProvider };
  }

  // Company tools — registered when this runner is part of a company session.
  if (opts.companyContext) {
    const { orchestrator, agentRole, isMaster, agentRunId } = opts.companyContext;
    registry.registerAll(buildBoardTools(orchestrator, agentRole, agentRunId));
    // Shared drive: persistent file pool scoped to the company template,
    // visible to master and every subordinate. Lets agents exchange large
    // documents without inflating board posts or inbox messages.
    registry.registerAll(buildSharedDriveTools());
    // Cross-agent comm tools — available to master AND subordinates. Moved
    // here from the unconditional native batch (P1): each errors or returns
    // just-self without a company session, so registering them in solo
    // sessions only bloated the prompt with peers that can't be reached.
    registry.registerAll(listAgentsTools);
    registry.registerAll(waitAgentsTools);
    registry.registerAll(sendMessageTools);
    registry.registerAll(sendInputTools);
    registry.registerAll(followupTaskTools);
    // Subordinate kanban tools: self-service card updates (comment, checklist, move-to-review)
    if (!isMaster && agentRunId != null) {
      registry.registerAll(buildSubordinateKanbanTools(orchestrator, agentRole, agentRunId));
      // QA tools: gated by skill (qa-playwright) via the skill's allowed-tools.
      // The tool is harmless when not used, so we register unconditionally for
      // subordinates and let the prompt-injector instructions discipline usage.
      registry.registerAll(buildQaTools(orchestrator, agentRole, agentRunId));
      // ds_* tools são exclusivas do DS Studio (sessão single) — o pipeline
      // company de Design System foi aposentado e sessões legacy são
      // read-only, então subordinados não recebem mais esse surface.
    }
    if (isMaster) {
      // review_subordinate_work needs in-process DB access to run the review
      // pipeline over a subordinate's snapshots — supply the shared handle and
      // a project-root resolver (same db/store already in scope here).
      registry.registerAll(
        buildMasterTools(orchestrator, {
          dbHandle: store.getDb(),
          getProjectRoot: (projectId: number) => db.getProject(projectId)?.root_path ?? null,
        }),
      );
      registry.registerAll(buildKanbanTools(orchestrator));
      // Strip code-level tools from Master — it should only orchestrate, not read code
      registry.filterInPlace(isMasterAllowed);
      console.log(`[coder] Master: filtered to ${registry.list().length} tools (orchestration-only)`);
    }
  }

  // Unified spawn tool — single entry point replacing the deprecated
  // spawn_subagent/spawn_agents pair. Schema accepts an `agents` array
  // (1 item → sequential, N → parallel, up to 8). Persistent kind delegates
  // to spawn_subordinate_agent when in a Company master session.
  if (subagentDeps || registry.get('spawn_subordinate_agent')) {
    // Either subagent deps exist (ephemeral path) OR master has the
    // subordinate path; in the latter we still register so the model has
    // a single dispatcher even without ephemeral capability.
    const fallbackDeps: SubagentDeps =
      subagentDeps
      ?? { provider, parentTools: [], sessionStore: store };
    registry.register(buildSpawnAgentTool(fallbackDeps, registry));
  }

  // execute_tasks — wave-based orchestrator (PR 3). Needs subagentDeps to
  // exist; only registers when the session has the subagent capability
  // (i.e. NOT a Company master, NOT CODER_DISABLE_SUBAGENTS=1).
  if (subagentDeps && registry.get('submit_tasks')) {
    const { buildExecuteTasksTool } = await import('@mcp/code-agent/tools/execute-tasks.js');
    registry.register(buildExecuteTasksTool(subagentDeps));
  }

  // Builder mode: when the company context carries a sandbox binding,
  // we pin `cwd` to the container workdir and swap the default ports
  // for sandbox-backed adapters. Every filesystem/shell tool from here
  // on transparently talks to the container — no conditional in the
  // tool code. The host `project.root_path` is ignored because there
  // is no host-side project in builder mode (yet).
  const sandboxBinding = opts.sandbox ?? opts.companyContext?.sandbox;
  // Defense-in-depth: if this is a builder-mode session (project sits
  // under `data/virtual-projects/`) but the companyContext has no
  // sandbox binding, something dropped it between orchestrator and
  // runCoder. The fallback below will use LocalFilesystemAdapter and
  // writes will silently land on the host — exactly the resume-path
  // bug we chased. Emit a loud warning so future regressions are
  // caught on the first run instead of via user screenshots.
  if (
    opts.companyContext &&
    !sandboxBinding &&
    project.root_path.replace(/\\/g, '/').includes('/data/virtual-projects/')
  ) {
    console.warn(
      `[coder] SUSPICIOUS: builder-mode session (project="${project.name}") but ` +
        `companyContext.sandbox is undefined — writes will land on the host at ` +
        `${project.root_path} instead of the sandbox container. This is almost ` +
        `certainly a missing binding-propagation in the orchestrator.`,
    );
  }
  const workspace: WorkspaceContext = workspaceFromProject(project, sandboxBinding);
  const effectiveCwd = workspace.rootPath;
  const rawFsPort = sandboxBinding
    ? new SandboxFilesystemAdapter({
        driver: sandboxBinding.driver,
        containerId: sandboxBinding.containerId,
      })
    : defaultLocalFilesystemPort();
  const shellPort = sandboxBinding
    ? new SandboxShellAdapter({
        driver: sandboxBinding.driver,
        containerId: sandboxBinding.containerId,
        defaultCwd: sandboxBinding.workdir,
      })
    : defaultLocalShellPort();

  // Per-session file-snapshot recorder: every write/unlink that the agent
  // performs is captured (baseline + edit-log row) so the user can review
  // and selectively keep/undo via the Snapshots tab. Bypassed for the
  // company subordinate path? No — subordinates write under the parent's
  // ToolContext anyway, but here this runner is its own session and may
  // also be a parent. We always record; UI scopes by `session_kind` +
  // `session_id` from this exact `runCoder` call.
  const snapshotStore = new SessionFileSnapshotStore(store.getDb());
  // Always record under the actual coder_sessions.id of the runner — even
  // inside company orchestration. Company-mode UI aggregates snapshots
  // across master + subordinate coder sessions by joining
  // `company_agent_runs.coder_session_id`, so per-project file paths
  // stay namespaced and unambiguous.
  let runnerRef: import('@mcp/code-agent/core/runner.js').CoderRunner | null = null;
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId: session.id,
    projectRoot: workspace.rootPath,
    store: snapshotStore,
    getTurn: () => runnerRef?.turn ?? null,
    onRecorded: opts.onSnapshotRecorded,
  });
  const fsPort = new SnapshotRecordingFilesystemPort(rawFsPort, recorder);

  // self_review — runs the configured snapshot_review/reviewer pipeline over
  // THIS session's active snapshots so the agent can validate its own work
  // before claiming done. Registered after the subagent parentTools snapshot
  // above so ephemeral subagents don't inherit it. Always available (bootstrap
  // tier); the CODER_SELF_REVIEW toggle only governs the proactive reminder.
  registry.register(
    buildSelfReviewTool({
      dbHandle: store.getDb(),
      sessionId: session.id,
      projectRoot: workspace.rootPath,
    }),
  );

  const toolContext: ToolContext = {
    cwd: effectiveCwd,
    projectName: workspace.displayName,
    overlay,
    toolOutputStore,
    unrestrictedToolOutput: !!session.unrestricted_tool_output,
    signal: opts.signal,
    // Persistence hooks for submit_plan — let the dashboard list plans
    // long after the live tool_use scrolled out of view.
    recordPlan: (toolUseId, planText) => {
      try {
        store.recordPlan({ session_id: session.id, tool_use_id: toolUseId, plan_text: planText });
      } catch (e) {
        console.warn(`[coder] recordPlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolvePlan: (toolUseId, status, feedback) => {
      try {
        store.resolvePlan(toolUseId, status, feedback);
      } catch (e) {
        console.warn(`[coder] resolvePlan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    setSessionAgent: (agent) => {
      try {
        store.setSessionAgent(session.id, agent);
      } catch (e) {
        console.warn(`[coder] setSessionAgent failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Apply the NEW agent's defaults to the LIVE runner so the next
      // mutating tool call in the same run unlocks immediately
      // (plan → build flow after `submit_plan` approval). Without this,
      // the runner kept the old `planMode=true` until the NEXT runCoder
      // invocation, so every edit between approval and the next user
      // message was refused by the plan-mode gate.
      //
      // Also emits `session_agent_changed` so the dashboard's AgentPicker
      // updates without a manual refetch (frontend listens on SSE).
      try {
        const live = runnerRef;
        if (live) {
          const def = AGENTS[agent];
          if (def) {
            // Apply the new agent's mode to the live runner so the next
            // mutating tool call unlocks/re-gates immediately (plan→build
            // after submit_plan approval). See CoderRunner.applyLiveAgent.
            live.applyLiveAgent(def, agent);
          }
          live.emit('session_agent_changed', { agent });
        }
      } catch (e) {
        console.warn(`[coder] setSessionAgent live-apply failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    // Tasks persistence — see migration 008 + SessionStore.recordTasks/etc.
    recordTasks: (toolUseId, state) => {
      try {
        store.recordTasks({ session_id: session.id, tool_use_id: toolUseId, state });
      } catch (e) {
        console.warn(`[coder] recordTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    resolveTasks: (verdict) => {
      try {
        store.resolveTasks(session.id, verdict);
      } catch (e) {
        console.warn(`[coder] resolveTasks failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    updateTaskStatus: (taskId, patch) => {
      try {
        return store.updateTaskStatus(session.id, taskId, patch);
      } catch (e) {
        console.warn(`[coder] updateTaskStatus failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    clearTasksState: () => {
      try {
        return store.clearTasksState(session.id);
      } catch (e) {
        console.warn(`[coder] clearTasksState failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    },
    getGoalState: () => {
      try {
        return store.getSessionGoal(session.id);
      } catch (e) {
        console.warn(`[coder] getSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    upsertGoalState: (goal) => {
      try {
        store.upsertSessionGoal(session.id, goal);
      } catch (e) {
        console.warn(`[coder] upsertSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    getTasksState: () => {
      try {
        return store.getTasksState(session.id);
      } catch {
        return null;
      }
    },
    // Session Drive sinks (migrations 125/126) — back the read_plan /
    // remember / list_memory / recall_investigations tools. Reads/writes
    // are best-effort; failures degrade to null/empty rather than aborting
    // the tool call.
    sessionDrive: {
      readActivePlan: () => {
        try {
          const p = store.listPlans(session.id)[0];
          return p ? { text: p.plan_text, status: p.status } : null;
        } catch {
          return null;
        }
      },
      remember: (input) => {
        const row = store.rememberMemory(session.id, input);
        return { title: row.title };
      },
      listMemory: (memOpts) => {
        try {
          return store.listSessionMemory(session.id, memOpts ?? {});
        } catch {
          return [];
        }
      },
      recallInvestigations: async (query, limit) => {
        // Semantic first (in-process embedder; worker/no-embedder → keyword).
        try {
          const embed = getInvestigationEmbedder();
          if (embed) {
            const vec = await embed(query);
            if (vec && vec.length > 0) {
              const hits = store.recallInvestigationsByVector(session.id, vec, limit);
              if (hits.length > 0) return hits;
            }
          }
        } catch {
          /* fall through to keyword */
        }
        try {
          return store.recallInvestigations(session.id, query, limit);
        } catch {
          return [];
        }
      },
    },
    companyContext: opts.companyContext,
    // Coder session id — keys per-agent resources (preview/devtools window).
    sessionId: session.id,
    // Surface indexing status to tools so DB-dependent paths can fall back
    // to disk/regex/tree-sitter instead of returning empty results.
    projectIndexed: undefined, // set after isIndexed is computed (see below)
    // Ports: sandbox-backed when the session is in builder mode,
    // otherwise local host filesystem/shell. Tools consume `ctx.ports`
    // uniformly and never branch on mode.
    ports: {
      fs: fsPort,
      shell: shellPort,
    },
  };

  // Load existing history FIRST so we can detect fresh vs resumed sessions
  // without a duplicate DB call. The block below (previously here) is now
  // merged into this one.
  const existingEarly = store.loadSessionWithMessages(session.id);
  const initialMessagesEarly: AgentMessage[] = existingEarly?.messages ?? [];
  // A durable compaction can leave a session with a summary but zero visible
  // rows (full "summarize & clear") — that's still a resumed session, not fresh.
  const hasHistory0 = initialMessagesEarly.length > 0 || !!existingEarly?.session.compaction_summary;

  // On session resume, recover tasks stuck in 'running' — the previous runner
  // died before the task could finish. Mark them as 'interrupted' so the model
  // can retry via execute_task.
  if (hasHistory0) {
    store.recoverStaleTasks(session.id);
  }

  // Resolve profile here (before buildSystemPrompt) so the prompt can render
  // the tier hint. Priority: explicit opts.profile → CODER_PROFILE env →
  // agentDef.profile → derived from history (resumed) or 'bootstrap' (fresh).
  //
  // Resumed sessions: instead of blanket 'full', scan the history's tool_use
  // blocks and pick the smallest profile that covers what was actually used.
  // Most resumed conversations only ever used bootstrap tools — promoting to
  // 'full' just to avoid hiding tools from history was paying tokens for
  // nothing on every turn.
  const historyToolNames: string[] = [];
  if (hasHistory0) {
    for (const m of initialMessagesEarly) {
      for (const b of m.content) {
        if (b.type === 'tool_use') historyToolNames.push(b.name);
      }
    }
  }
  const rawProfile0 =
    opts.profile ??
    (process.env.CODER_PROFILE as CoderProfile | 'auto' | undefined) ??
    (agentDef?.profile) ??
    (hasHistory0 ? inferProfileFromHistory(historyToolNames) : 'bootstrap');
  const preResolvedProfile: CoderProfile =
    rawProfile0 === 'auto' ? inferProfileFromMessage(opts.userMessage ?? '') : rawProfile0;

  // ─── Skills ────────────────────────────────────────────────────
  // Opens a long-lived SkillStore that survives until the runner's `done`
  // promise resolves — the runner reads it every turn from inside
  // `assembleMessagesForChat` to materialize the `<active_skills>` block
  // for messages the user sent with sidebar picks. Closed in the run's
  // `finally` hook below alongside the other per-run resources.
  const skillStore = new SkillStore(config.dbPath);
  let resolvedSkills: ResolvedSkill[] = [];
  try {
    resolvedSkills = skillStore.resolveActiveSkills(session.id, session.project_id);
  } catch (e) {
    console.warn(`[coder] skill resolution failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const skillTemplateCtx: SkillTemplateContext = {
    PROJECT_NAME: project.name,
    PROJECT_ROOT: project.root_path,
    SESSION_ID: String(session.id),
    OS: process.platform,
    TIMESTAMP: new Date().toISOString(),
  };

  if (resolvedSkills.length > 0) {
    // Discovery tools — always registered for all active skills.
    // installedNamespaces enriches list_skill_namespaces with repo/commit;
    // best-effort (a DB read failure must not block the session).
    let installedNamespaces: ReturnType<typeof listInstalledNamespaces> | undefined;
    try {
      installedNamespaces = listInstalledNamespaces();
    } catch {
      installedNamespaces = undefined;
    }
    registry.registerAll(
      buildSkillDiscoveryTools(
        resolvedSkills,
        skillTemplateCtx,
        store,
        session.id,
        installedNamespaces,
      ),
    );

    // invoke_skill — only for tool-mode skills (logs usage)
    const toolModeSkills = resolvedSkills.filter(
      (s) => s.contextMode === 'tool' || s.contextMode === 'both',
    );
    if (toolModeSkills.length > 0) {
      registry.register(
        buildInvokeSkillTool(toolModeSkills, skillTemplateCtx, config.dbPath, session.id, store),
      );
    }
  }

  // create_skill — registered unconditionally (navigate tier) so the agent can
  // author the FIRST skill in an empty catalog. Captures dbPath + registry for
  // tool-name validation and the trigger eval.
  registry.register(
    buildCreateSkillTool({ dbPath: config.dbPath, registry, projectId: session.project_id }),
  );

  // Detect indexing status — used for prompt conditioning and dashboard feedback.
  const projectStats = db.getStats(project.id);
  const isIndexed = (projectStats?.file_count ?? 0) > 0 && (projectStats?.run_count ?? 0) > 0;
  const indexStatus: IndexStatus = { isIndexed, mcpAvailable: mcpBridgeOk };
  toolContext.projectIndexed = isIndexed;

  // Strip MCP tools that strictly depend on the symbol DB when the project
  // has never been indexed. These would otherwise return empty/error
  // results and waste turns. Disk-aware tools (mcp__read_file,
  // mcp__list_directory, mcp__grep_code via ripgrep, etc.) stay registered.
  if (!isIndexed) {
    // Tools that genuinely need the symbol DB or vector store. Tools that
    // gained a tree-sitter / disk-grep fallback (find_references,
    // prepare_edit, trace_usage, get_symbol_body, get_file_skeleton,
    // get_file_structure, grep_code) are kept registered — they work
    // without an index and degrade gracefully.
    const indexDependent = new Set<string>([
      'get_symbol_details', 'get_class_members',
      'get_hierarchy', 'find_implementations',
      'semantic_neighbors',
      'get_dependencies', 'get_dependents',
      'search', 'search_global', 'search_concepts', 'search_by_kind',
      'get_project_overview', 'get_project_pulse',
      'get_architecture', 'get_repo_map',
      'get_context_for', 'query_snapshots', 'get_project_context',
    ]);
    const isIndexDep = (toolName: string): boolean => {
      // Strip mcp__ prefix and any company-master per-project slug
      // (mcp__{slug}__name → name).
      const tail = toolName.replace(/^mcp__/, '').replace(/^[^_]+__/, '');
      return indexDependent.has(tail);
    };
    const before = registry.list().length;
    registry.filterInPlace((t) => t.source === 'native' || !isIndexDep(t.name));
    const after = registry.list().length;
    if (before !== after) {
      console.log(`[coder] project not indexed — stripped ${before - after} index-dependent MCP tools`);
    }
  }

  // Optional repo map (B6). Auto-sized by indexed file count: 0 (<50 files),
  // 1500 chars (50-499), 3000 (500-1999), 4500 (≥2000). Set CODER_REPOMAP_TOKENS
  // to a positive integer to override the auto budget, or "0" to disable.
  // Skipped when the project has never been indexed (no symbols to map).
  const repoMapBudget = resolveRepoMapBudget(db, project.id, isIndexed);
  const repoMap = repoMapBudget > 0
    ? buildRepoMap(db, project.id, repoMapBudget)
    : '';

  // Agent Loop v2 — ON by default for new sessions. Set CODER_AGENT_LOOP_V2=0
  // to opt out (e.g. for cache-stability comparisons or to roll back without
  // a deploy). Resolved here so the static "Agent loop" + "Active context"
  // pointer in the system prompt and the runner's <active-context> injection
  // stay in sync.
  const agentLoopV2EnvFlag = process.env.CODER_AGENT_LOOP_V2 !== '0';

  let systemPrompt = buildSystemPrompt({
    projectName: project.name,
    projectRoot: project.root_path,
    os: process.platform,
    planMode: opts.planMode,
    providerFamily: session.provider as CoderProviderName,
    profile: preResolvedProfile,
    sessionId: String(session.id),
    customTiers: customTierSummary.size > 0
      ? [...customTierSummary.entries()].map(([tier, info]) => ({
          tier,
          displayName: info.displayName,
          toolCount: info.toolCount,
        }))
      : undefined,
    mcpAvailable: mcpBridgeOk,
    isIndexed,
    repoMap,
    agentLoopV2: agentLoopV2EnvFlag,
    agentId: effectiveAgentId ?? undefined,
    sessionDrive: !opts.companyContext,
  });

  // Append company prompt block (master orchestration or subordinate instructions)
  if (opts.companyPromptBlock) {
    systemPrompt += '\n' + opts.companyPromptBlock;
  }

  // DS Studio block — appended (not replacing the agent prompt) so the
  // `builder` agent identity stays intact and the prefix remains
  // cache-stable: every value comes from builder_json, fixed at scaffold
  // time, no DB query per turn.
  if (dsWorkspace) {
    systemPrompt += '\n' + interpolate(loadPrompt('ds-studio'), {
      packageName: dsWorkspace.packageName ?? '(see ds_get_session_info)',
      stack: dsWorkspace.stack,
      publishExtra: dsWorkspace.stack === 'angular'
        ? '4. Angular only: run `ng build pkg` first and publish the BUILT output (`ds_publish_version({ pkg_dir: "dist/pkg" })`).'
        : '',
    });
  } else if (dsConsumer && config.features.designSystemEnabled) {
    // DS consumer block — derives from the pinned published version
    // (immutable rows), so the prefix stays byte-stable across turns.
    systemPrompt += '\n' + buildDsConsumerBlock(dsConsumer);
  }

  // Append skill awareness block. Mode resolution priority:
  //   1. Explicit env CODER_SKILLS_PROMPT_MODE = lazy | compact | matched | full
  //   2. Company context present (master/subordinate) → 'matched' (existing
  //      behaviour: matcher filters skills by role/tag/path)
  //   3. Otherwise → 'lazy' (default — skills discoverable via get_skills_list
  //      tool, ~30 tokens vs ~3000 for full)
  //
  // Sessions with 30+ skills used to spend ~3000 tokens of every turn just
  // describing skills the agent would never call. The lazy default trims
  // that to a single pointer while keeping discovery a tool call away.
  let skillsModeUsed: 'lazy' | 'compact' | 'matched' | 'full' | 'none' = 'none';
  if (resolvedSkills.length > 0) {
    const envMode = (process.env.CODER_SKILLS_PROMPT_MODE ?? '').toLowerCase().trim();
    const inCompany = !!opts.companyContext;
    const mode: 'lazy' | 'compact' | 'matched' | 'full' =
      envMode === 'lazy' || envMode === 'compact' || envMode === 'matched' || envMode === 'full'
        ? envMode
        : inCompany
          ? 'matched'
          : 'lazy';

    if (mode === 'lazy') {
      systemPrompt += buildLazySkillsSection(resolvedSkills);
      skillsModeUsed = 'lazy';
    } else if (mode === 'compact') {
      systemPrompt += buildCompactSkillsSection(resolvedSkills);
      skillsModeUsed = 'compact';
    } else if (mode === 'matched') {
      // Path triggers fire from `recentFiles`. Outside company context we
      // approximate that with file-shaped tokens in the user message
      // (relative paths and *.ext mentions). Misses some — that's fine,
      // the skill is still discoverable via get_skills_list.
      const userMsg = opts.userMessage ?? '';
      const recentFiles = extractFilePathsFromText(userMsg);
      const matchCtx: SkillMatchContext = {
        role: opts.companyContext?.agentRole,
        mode: opts.companyContext?.isMaster ? 'master' : opts.companyContext ? 'subordinate' : undefined,
        cwd: project.root_path,
        recentFiles,
        sessionTags: [],
      };
      const matched = matchSkills(resolvedSkills, matchCtx);
      if (matched.length > 0) {
        systemPrompt += buildMatchedSkillsPromptSection(matched, skillTemplateCtx);
        skillsModeUsed = 'matched';
      } else {
        // No matches: degrade to lazy rather than dumping the full list.
        systemPrompt += buildLazySkillsSection(resolvedSkills);
        skillsModeUsed = 'lazy';
      }
    } else {
      systemPrompt += buildSkillsPromptSection(resolvedSkills, skillTemplateCtx);
      skillsModeUsed = 'full';
    }
  }

  // Persist the fully assembled system prompt for the Input tab in the
  // session details modal. Dedup by hash inside SessionStore — typical
  // restarts are byte-identical (cache prefix is intentionally stable).
  store.recordSessionInput({
    session_id: session.id,
    kind: 'system_prompt',
    source_label: 'turn-start',
    content: systemPrompt,
    meta: {
      provider: session.provider,
      profile: preResolvedProfile,
      planMode: !!opts.planMode,
      mcp_available: mcpBridgeOk,
      skill_ids: resolvedSkills.map((s) => s.id),
      skills_mode: skillsModeUsed,
      company_role: opts.companyContext?.agentRole ?? null,
      is_master: !!opts.companyContext?.isMaster,
    },
  });

  // Reuse the history we loaded early for profile resolution. When a durable
  // compaction boundary is set, PREPEND its summary so the model starts from
  // "summary + recent tail" (the loaders already return only id > boundary).
  const compactionSummary0 = existingEarly?.session.compaction_summary;
  const initialMessages: AgentMessage[] = compactionSummary0
    ? [{ role: 'user', content: [{ type: 'text', text: compactionSummary0 }] }, ...initialMessagesEarly]
    : initialMessagesEarly;

  const activeTiers = profileToTiers(preResolvedProfile);
  // Auto-activate the `master` tier for company-master sessions. Master
  // orchestration tools (spawn_subordinate_agent, list_subordinates,
  // kanban_list_cards, kanban_get_card, etc.) live in their own tier so
  // they're discoverable via `find_tools` / `expand_toolset` and don't
  // pollute non-master sessions. The tier is opt-in for everyone else
  // via `expand_toolset('master')`.
  if (opts.companyContext?.isMaster) {
    activeTiers.add('master');
  }
  // Auto-activate the `preview` tier (DevTools tools) ONLY when the caller
  // says preview is contextually relevant (`opts.previewAvailable` — set for
  // builder / dev-server project sessions in stream.ts). We deliberately do
  // NOT fall back to `getGlobalPreviewDevtools()`: the worker installs the
  // bridge shim unconditionally, so that would make the tier always-on and
  // ship 16 tools to every session. Other sessions (generic chat, company)
  // unlock it on demand via `find_tools` → `expand_toolset('preview')`.
  if (opts.previewAvailable) {
    activeTiers.add('preview');
  }
  if (process.env.CODER_LOG_TOOLS_COUNT === '1') {
    console.log(
      `[coder] agent=${effectiveAgentId ?? 'none'} profile=${preResolvedProfile} planMode=${opts.planMode ?? false} active_tiers=${Array.from(activeTiers).sort().join(',')}`,
    );
  }

  // ─── Runtime hooks ─────────────────────────────────────────────
  const hookRegistry = new RuntimeHookRegistry();
  if (opts.companyContext && !opts.companyContext.isMaster && opts.companyContext.agentRunId != null) {
    registerCompanyHooks(
      hookRegistry,
      opts.companyContext.orchestrator,
      opts.companyContext.agentRunId,
      opts.companyContext.agentRole,
    );
  }

  // ─── Sandbox preview auto-reload (builder mode only) ──────────
  // When an agent writes/edits a file inside the sandbox, publish a
  // `sandbox.file_changed` event on the metaBus so the dashboard can
  // refresh the iframe without the user clicking reload. Debounced so
  // a burst of edits in a single turn collapses into one reload.
  if (opts.companyContext?.sandbox) {
    const orch = opts.companyContext.orchestrator;
    const FILE_WRITE_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit', 'manage_path']);
    const pending = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_WRITE_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const rawPaths = [ctx.toolArgs.path ?? ctx.toolArgs.file_path];
      if (ctx.toolName === 'manage_path') rawPaths.push(ctx.toolArgs.from_path, ctx.toolArgs.to_path);
      for (const raw of rawPaths) {
        if (raw == null) continue;
        const path = typeof raw === 'string' ? raw : String(raw);
        if (path) pending.add(path);
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const paths = [...pending];
        pending.clear();
        debounceTimer = null;
        try {
          orch.sandboxService.publishFileChanged(paths);
        } catch {
          // best-effort — never crash the runner on a UI-notification hook
        }
      }, 300);
    });
  }

  // ─── Incremental symbol re-indexing ──────────────────────────
  // Keep the symbol DB fresh as the agent edits files. Tree-sitter only —
  // no LLM cost. Only runs when the project is already indexed (a brand-new
  // project still needs the full pipeline to populate `files` rows). Fire
  // and forget: the hook returns immediately and the indexer runs in the
  // background while the next turn begins.
  if (isIndexed && !sandboxBinding) {
    const FILE_MUTATING_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit', 'manage_path']);
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_MUTATING_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const rawPaths = [ctx.toolArgs.path ?? ctx.toolArgs.file_path];
      if (ctx.toolName === 'manage_path') rawPaths.push(ctx.toolArgs.from_path, ctx.toolArgs.to_path);
      const rawStrs = rawPaths
        .filter((raw): raw is string | number | boolean => raw != null)
        .map((raw) => (typeof raw === 'string' ? raw : String(raw)))
        .filter(Boolean);
      if (rawStrs.length === 0) return;
      // Normalize to the same shape the scanner stores in `files.path`:
      // forward slashes, no leading `./`, no trailing slash. Without this,
      // `db.getFile(projectId, relPath)` misses on Windows (backslashes) or
      // when the agent passes `./src/foo.ts`, and the tree-sitter refresh
      // is silently skipped.
      for (const rawStr of rawStrs) {
        const relPath = rawStr.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        // Async, non-blocking. `loadIncrementalIndexer` (module-level lazy
        // singleton above) defers the tree-sitter WASM load to the first
        // mutation in this process — sessions that never edit code pay
        // zero cost. Subsequent calls reuse the cached `indexFileNow`
        // reference without re-entering the module resolver.
        void (async () => {
          try {
            const indexFileNow = await loadIncrementalIndexer();
            const abs = resolvePath(toolContext.cwd, relPath);
            const content = await (toolContext.ports?.fs ?? defaultLocalFilesystemPort()).readFile(abs);
            await indexFileNow(db, project.id, relPath, content);
          } catch {
            // best-effort — never crash on incremental refresh failures
          }
        })();
      }
    });
  }

  // ─── Fallback chain ───────────────────────────────────────────
  // Always defined so the runner can refresh OAuth credentials (e.g. the
  // Copilot 25-min token) on 401 even when no fallback chain is configured.
  const createProviderForFallback = async (name: string, model: string) => {
    return createCoderProvider(name, model);
  };
  let fallbackChain: import('@mcp/code-agent/core/fallback.js').FallbackChain | undefined;
  try {
    const { buildFallbackChain } = await import('@mcp/code-agent/core/fallback.js');
    const providerStore = new ProviderStore(config.dbPath);
    const sessionFallback = store.getSessionFallback(session.id);
    const providerChain = providerStore.getFallbackChain(session.provider);
    providerStore.close();
    const chain = buildFallbackChain(
      sessionFallback,
      providerChain,
      process.env.CODER_FALLBACK_CHAIN,
    );
    if (chain.entries.length > 0) {
      fallbackChain = chain;
      console.log(`[coder] Fallback chain: ${chain.entries.map((e) => `${e.provider}:${e.model}`).join(' → ')}`);
    }
  } catch {
    // Fallback config not available (migration not run yet) — skip silently
  }

  // ─── Context window (DB-first, registry fallback) ────────────────
  // The DB is the source of truth WHEN populated, but ZAI / new model
  // releases / hand-imported configs frequently leave it null. Fall back
  // to the static registry (which now has prefix-matching, see
  // capabilities.ts) so the dashboard's context bar renders for legacy
  // sessions without forcing a re-discovery.
  let sessionContextWindow: number | null = null;
  try {
    const ps = new ProviderStore(config.dbPath);
    const dbModel = ps.listModels(session.provider).find((m) => m.model_id === session.model);
    ps.close();
    sessionContextWindow = dbModel?.context_window ?? null;
  } catch {
    // Non-fatal — registry fallback below
  }
  if (sessionContextWindow == null && session.model) {
    const { getRegistryContextWindow } = await import('@mcp/code-agent/providers/capabilities.js');
    const fromRegistry = getRegistryContextWindow(session.model);
    if (fromRegistry != null) {
      sessionContextWindow = fromRegistry;
      console.log(
        `[coder] context_window resolved via registry fallback for ${session.provider}/${session.model}: ${fromRegistry}`,
      );
    }
  }

  // Phase Profiles (Camada 2) was REMOVED — sessions run on a single
  // (provider, model) for their entire lifetime. The DB column
  // `coder_sessions.phase_profile_id` is left untouched for any future
  // re-enable; the runner ignores it.

  // Agent Loop v2 — ON by default for new sessions. When enabled, the runner
  // injects a live <active-context> block per turn, adds a static "Agent
  // loop" framing to the system prompt, applies a stop-guard for unfinished
  // todos, includes a recap on auto-continue, and refuses tool calls that
  // produce identical content to a recent result. Set CODER_AGENT_LOOP_V2=0
  // to disable.
  const agentLoopV2 = agentLoopV2EnvFlag;

  // Fix A — self_review nudge signals. Reuses `snapshotStore` (active
  // baselines) + a review store (auto-review runs) so the Executing node only
  // nudges when there are UNREVIEWED changes — instead of every turn that has
  // any pending snapshot (forever, since `self_review` never closes them).
  const reviewStore = new SessionFileReviewStore(store.getDb());
  // SQLite `datetime('now')` is UTC `YYYY-MM-DD HH:MM:SS` → ms-epoch.
  const sqliteToMs = (s: string | null): number | null => {
    if (!s) return null;
    const ms = Date.parse(`${s.replace(' ', 'T')}Z`);
    return Number.isNaN(ms) ? null : ms;
  };

  const runner = new CoderRunner({
    provider,
    registry,
    systemPrompt,
    toolContext,
    initialMessages,
    sessionId: session.id,
    sessionStore: store,
    skillStore,
    // self_review reminder signal — true when this session has active
    // (un-kept/un-reverted) snapshots worth validating. Drives the
    // CODER_SELF_REVIEW system-reminder nudge in the Executing node.
    hasReviewableChanges: () => {
      try {
        return snapshotStore.listActiveBaselineIds('coder', session.id).length > 0;
      } catch {
        return false;
      }
    },
    // Fix A — richer self_review signals (pending-change fingerprint + last
    // auto-review marker) so the nudge fires only for UNREVIEWED changes and
    // hard-stops after a cap. Best-effort: any read error → null (node falls
    // back to `hasReviewableChanges`).
    collectSelfReviewSignals: () => {
      try {
        const actives = snapshotStore.listBaselines('coder', session.id);
        const editMs = actives
          .map((b) => sqliteToMs(b.last_edited_at))
          .filter((n): n is number => n != null);
        const lastEditAt = editMs.length ? Math.max(...editMs) : null;
        const pendingFingerprint = actives.length ? `${actives.length}:${lastEditAt ?? 0}` : '';
        const autoCompleted = reviewStore
          .listRuns('coder', session.id)
          .filter((r) => r.source === 'auto' && r.status === 'completed');
        const reviewMs = autoCompleted
          .map((r) => sqliteToMs(r.completed_at))
          .filter((n): n is number => n != null);
        const lastReviewAt = reviewMs.length ? Math.max(...reviewMs) : null;
        return { pendingFingerprint, lastEditAt, lastReviewAt, totalAutoReviews: autoCompleted.length };
      } catch {
        return null;
      }
    },
    // Mem C — proactive project-memory retrieval. Wired only when the host
    // provided a retriever AND this project has memory enabled (migration 115);
    // the Executing node awaits it before assembly and injects relevant memory.
    getRelevantProjectMemory:
      opts.memoryRetriever && db.getProjectMemoryEnabled(project.id)
        ? (taskText: string) => opts.memoryRetriever!.retrieve(project.id, project.name, taskText)
        : undefined,
    // Session Drive injection (migrations 125/126) — non-company sessions
    // only. Surfaces the active plan + saved notes + investigation count so
    // they survive compaction. Best-effort: any read error → no injection.
    getSessionDriveInjection: opts.companyContext
      ? undefined
      : () => {
          try {
            return store.getDriveInjectionPayload(session.id);
          } catch {
            return null;
          }
        },
    // (assignment below) — keeps recorder in sync with runner.turn
    // even though the runner is constructed after recorder. The recorder
    // reads `runnerRef?.turn` lazily, so this assignment closes the loop.
    maxTurns: opts.maxTurns ?? 50,
    planMode: opts.planMode,
    specMode: opts.specMode ?? (effectiveAgentId === 'spec'),
    thinking: opts.thinking,
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    modelSupportsVision: opts.modelSupportsVision,
    describeImages: opts.describeImages,
    deepThink: opts.deepThink,
    deepThinkModel: opts.deepThinkModel,
    deepThinkProvider: opts.deepThinkProvider,
    preThinkOnToolResults: opts.preThinkOnToolResults,
    activeTiers,
    globalDisabledTools,
    sessionDisabledTools: sessionDisabledTools.size > 0 ? sessionDisabledTools : undefined,
    externalToolTiers,
    fallbackChain,
    createProvider: createProviderForFallback,
    hookRegistry: hookRegistry.hasHandlers ? hookRegistry : undefined,
    context_window: sessionContextWindow,
    isCompanySubordinate: opts.companyContext != null && !opts.companyContext.isMaster,
    companyRoleOverride: opts.companyRoleOverride,
    // Plumb the company identifiers through so per-turn quality verdicts
    // can be attributed to the right subordinate run and routed back via
    // the global QualityResultObserver (Wire #3 kanban gate, Wire #4
    // off-topic→master inbox alert). Null for chat-individual sessions
    // — those don't carry company context.
    companyAgentRunId: opts.companyContext?.agentRunId ?? null,
    companySessionId: opts.companyContext?.companySessionId ?? null,
    adminOverride: opts.adminOverride,
    agentId: effectiveAgentId,
    sessionTemperature: session.temperature_override,
    roleTemperature: opts.roleTemperature,
    // Per-session unrestricted-tool-output toggle (migration 078). Lifts the
    // per-block PUSH_TIME_CAP to the high safety ceiling so verbose MCP tools
    // (Unity, large file reads, batched code_exec) arrive intact.
    unrestrictedToolOutput: !!session.unrestricted_tool_output,
    // Tool permission mode (migration 131). Company runs force 'unrestricted'
    // in V1 — the company board has no approval UI yet, so a paused
    // subordinate would hang invisibly. Single sessions read the column
    // (NULL → 'auto'). Explicit opt wins (tests / future company V2).
    toolPermissionMode: opts.toolPermissionMode
      ?? (opts.companyContext
        ? 'unrestricted'
        : normalizeToolPermissionMode(session.tool_permission_mode)),
    // A1 — per-session tunables (push caps, turn budget). Undefined →
    // runner uses envTunables() = bit-identical to pre-A1 constants.
    tunables: opts.tunables,
    // Stateful Responses API resume — populated only for ChatGPT/Codex sessions
    // that completed at least one turn with `store: true`. Other providers
    // ignore these fields.
    previousResponseId: session.last_response_id,
    previousResponseMessageCount: session.last_response_message_count,
    onResponseId: (responseId, messageCount) => {
      try {
        store.setLastResponseState(session.id, responseId, messageCount);
      } catch (e) {
        console.warn(
          `[coder] setLastResponseState failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    agentLoopV2,
    // ToolSelectionPipeline filter — per-call override wins, otherwise
    // we fall back to the module-level global installed by the boot
    // path (see `setGlobalToolSelectionFilter`). When neither is set,
    // the field is undefined and the runner skips the hook entirely.
    toolSelectionFilter: opts.toolSelectionFilter ?? getGlobalToolSelectionFilter(),
  });

  // Rehydrate the lightweight todo list from the DB so a session resume
  // brings back the sidebar state the user saw before the restart.
  if (session.todos_json) {
    try {
      const parsed = JSON.parse(session.todos_json) as Array<Partial<import('@mcp/code-agent/tools/todo.js').TodoItem>>;
      if (Array.isArray(parsed)) {
        // Backfill missing ids on legacy rows (pre-id schema). Persist the
        // mutated list back ONCE so future resumes see the same ids — without
        // this the agent would see a different id on each resume and lose
        // update_todo continuity.
        let backfilled = false;
        const hydrated = parsed.map((t) => {
          const id = typeof t.id === 'string' && t.id.length >= 6 ? t.id : (backfilled = true, generateTodoId());
          return {
            id,
            content: typeof t.content === 'string' ? t.content : '',
            activeForm: typeof t.activeForm === 'string' ? t.activeForm : '',
            status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending' as const,
          };
        });
        // Bypass the event emitter on rehydrate — the runner isn't listening
        // yet and we don't want to double-persist on startup.
        runner.currentTodos = hydrated;
        if (backfilled) {
          try {
            store.setSessionTodos(session.id, JSON.stringify(hydrated));
          } catch (e) {
            console.warn(`[coder] failed to persist backfilled todo ids: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[coder] failed to parse todos_json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist todos on every `todos_updated` event and re-emit nothing else.
  runner.on('todos_updated', ({ todos }) => {
    try {
      store.setSessionTodos(session.id, JSON.stringify(todos));
    } catch (e) {
      console.warn(`[coder] setSessionTodos failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Session-start worktree: when the caller passes `opts.worktree` AND the
  // session does not already have one persisted, create the worktree now
  // and scope the runner into it before the first turn. This is the primary
  // path — users decide "run in an isolated worktree" once, at creation,
  // instead of having the agent figure it out mid-run via the admin tool.
  if (opts.worktree && !session.worktree_path) {
    const created = createProjectWorktree(resolvePath(project.root_path), opts.worktree);
    if (created.ok) {
      runner.enterWorktreeScope(created.path);
      try {
        store.setSessionWorktree(session.id, created.path);
      } catch (e) {
        console.warn(`[coder] failed to persist session worktree: ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(`[coder] session ${session.id} started in worktree ${created.path} (branch ${created.branch})`);
    } else {
      console.warn(`[coder] session-start worktree creation failed: ${created.error} — running in the project root instead`);
    }
  }

  // Rehydrate the worktree scope on session resume. If the DB says this
  // session was inside a worktree when the server stopped, put the runner
  // back there before the first turn runs so tool calls see the right cwd.
  if (session.worktree_path && existsSync(session.worktree_path)) {
    // Only enter if the session-start path above didn't already do it.
    if (!runner.worktreePath) runner.enterWorktreeScope(session.worktree_path);
  } else if (session.worktree_path) {
    // Worktree directory was deleted externally — clear the column so the
    // next resume doesn't trip on the stale path.
    console.warn(`[coder] session ${session.id} worktree_path ${session.worktree_path} no longer exists — clearing`);
    try {
      store.setSessionWorktree(session.id, null);
    } catch {
      /* ignore */
    }
  }

  // Persist worktree enter/exit so a server restart can resume in the same cwd.
  runner.on('worktree_entered', ({ path }) => {
    try {
      store.setSessionWorktree(session.id, path);
    } catch (e) {
      console.warn(`[coder] setSessionWorktree (enter) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  runner.on('worktree_exited', () => {
    try {
      store.setSessionWorktree(session.id, null);
    } catch (e) {
      console.warn(`[coder] setSessionWorktree (exit) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  if (!opts.resume) {
    const userBlocks = attachmentsToBlocks(opts.userMessage, opts.attachments);
    const pickExtras =
      opts.selectedSkillIds && opts.selectedSkillIds.length > 0
        ? { selectedSkillIds: opts.selectedSkillIds }
        : undefined;
    runner.pushUserContent(userBlocks, pickExtras);
    store.appendMessage(session.id, {
      role: 'user',
      content: userBlocks,
      ...(pickExtras ?? {}),
    });
  } else {
    // Resume: tool_result was already appended to the DB by the API handler.
    // It is already part of initialMessages → runner.messages, so the
    // turn_start flush below must skip it. The submit_plan handler that
    // produced this resume path also calls approvePlan() inline; we need to
    // re-apply that here so the runner accepts mutating tools.
    const last = runner.messages[runner.messages.length - 1];
    if (last?.role === 'tool') {
      for (const b of last.content) {
        if (b.type === 'tool_result' && /Plan approved by user/.test(b.content)) {
          runner.approvePlan();
          break;
        }
      }
    }
  }
  store.updateSessionStatus(session.id, 'running');

  // Persist assistant messages and tool results as the runner emits them.
  // We need to map tool_call_results back to the message they belong to,
  // Per-turn buffer: accumulate assistant message + all its tool results, then
  // flush to the DB in a single transaction at turn boundary. Prevents orphaned
  // tool rows if the process crashes mid-turn.
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  interface PendingTurn {
    message: AgentMessage;
    usage: ChatUsage | null;
    toolCalls: Array<{
      tool_use_id: string;
      tool_name: string;
      args: Record<string, unknown>;
      result_text: string;
      is_error: boolean;
      duration_ms: number;
      output_chars: number;
      /**
       * Size the LLM actually saw (post reduce+cap). Set in the
       * `tool_call_result` handler from result.content.length; pair with
       * output_chars (raw) to compute savings.
       */
      output_chars_shaped: number | null;
      truncated: boolean;
      phase: string | null;
      turn_telemetry_id: number | null;
    }>;
    subagentUsage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  }
  /**
   * Cheap heuristic for the `truncated` flag in coder_tool_calls. Mirrors the
   * markers emitted by mcp-bridge.ts (MCP_OUTPUT_HARD_CAP, READ_FILE clamp).
   * False negatives are fine — the dashboard treats this as a noisy-tool
   * signal, not a billing input.
   */
  const isTruncatedOutput = (s: string): boolean => {
    if (!s) return false;
    return s.includes('[output truncated') || s.includes('[clamped from ');
  };
  let pendingTurn: PendingTurn | null = null;

  const flushPendingTurn = async (): Promise<void> => {
    if (!pendingTurn) return;
    const turn = pendingTurn;
    pendingTurn = null;
    // By now persistTurnTelemetry has run for this turn (runner emits
    // it before turn_start), so lastTurnTelemetryId points at the row we
    // want to JOIN against. Stamp every tool call with it.
    const telemetryId = runner.lastTurnTelemetryId;
    if (telemetryId != null) {
      for (const tc of turn.toolCalls) tc.turn_telemetry_id = telemetryId;
    }
    const hasSubUsage = turn.subagentUsage.input_tokens > 0
      || turn.subagentUsage.output_tokens > 0;
    const payload = {
      session_id: session.id,
      message: turn.message,
      usage: turn.usage,
      tool_calls: turn.toolCalls,
      subagent_usage: hasSubUsage ? turn.subagentUsage : undefined,
    };
    try {
      if (dbWriter) {
        await dbWriter.persistAssistantTurn(payload);
      } else {
        store.persistAssistantTurn(payload);
      }
    } catch (err) {
      // Non-fatal: the agent loop continues. The bus log is the authoritative
      // transcript and can be reconstructed if persistence fails for one turn.
      console.error(`[coder] persistAssistantTurn failed for session ${session.id}:`, err);
    }
  };

  runner.on('tool_call_start', (id, name, input) => {
    pendingToolCalls.set(id, { name, input });
  });

  runner.on('message_complete', (message, usage) => {
    if (message.role !== 'assistant') return;
    // A new assistant message replaces any prior buffered turn that had no
    // tool calls (e.g., a pure-text turn). Persist the prior one first.
    flushPendingTurn();
    pendingTurn = {
      message,
      usage: usage ?? null,
      toolCalls: [],
      subagentUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });

  runner.on('tool_call_result', (id, name, result, durationMs) => {
    if (!pendingTurn) return;
    const pending = pendingToolCalls.get(id);
    const content = result.content ?? '';
    pendingTurn.toolCalls.push({
      tool_use_id: id,
      tool_name: name,
      args: pending?.input ?? {},
      result_text: content,
      is_error: Boolean(result.isError),
      duration_ms: durationMs,
      // output_chars = RAW tool output (pre-reduce, from result.rawChars);
      // output_chars_shaped = what the LLM saw (post reduce+cap = content).
      // Savings = output_chars - output_chars_shaped. Synthetic refusals carry
      // no rawChars → raw==shaped (savings 0). Both sourced from this single
      // event (the old tool_call_finalized stamp raced and never landed).
      output_chars: result.rawChars ?? content.length,
      output_chars_shaped: content.length,
      truncated: isTruncatedOutput(content),
      // PhaseRouter removed — column kept for backward compat with old rows
      // that have it set. Always null going forward.
      phase: null,
      // Stamped at flushPendingTurn time, when persistTurnTelemetry has
      // already run for this turn and runner.lastTurnTelemetryId is the
      // id of THIS turn's row. Setting it here would point at the prior turn.
      turn_telemetry_id: null,
    });
    // Accumulate subagent usage for this turn — flushed with the transaction
    // so dashboard cost totals can never show partial spend.
    if (result.subUsage) {
      pendingTurn.subagentUsage.input_tokens += result.subUsage.input_tokens;
      pendingTurn.subagentUsage.output_tokens += result.subUsage.output_tokens;
      pendingTurn.subagentUsage.cache_read_input_tokens += result.subUsage.cache_read_input_tokens ?? 0;
      pendingTurn.subagentUsage.cache_creation_input_tokens += result.subUsage.cache_creation_input_tokens ?? 0;
    }
    pendingToolCalls.delete(id);
  });

  // output_chars_shaped is set directly in the `tool_call_result` handler
  // above (from result.content.length). The old `tool_call_finalized` DB stamp
  // raced the result event — finalized fired during dispatch, before the
  // tool_call_result row existed — so it never landed (100% NULL). The
  // `tool_call_finalized` event still fires for the live dashboard badge.

  // Persist the buffered assistant turn at each turn boundary.
  // `persistAssistantTurn` writes the assistant message, the tool_calls audit
  // rows, AND the paired 'tool' role message in a single transaction (see
  // store/messages.ts), so there is no separate tool-message flush to keep in
  // sync. The previous approach scanned `runner.messages` from an integer
  // cursor, which raced compaction: the Compacting node reassigns
  // `ctx.messages` to a new, shorter array, leaving the cursor past its end so
  // the scan silently stopped persisting tool messages for the rest of the run
  // (session 969: ~38 turns of tool results lost while the audit rows survived).
  runner.on('turn_start', () => {
    void flushPendingTurn();
  });

  // Capture the last error emitted by the runner so we can propagate it
  // through the done promise. The runner emits `done('error', Error)` but
  // `run()` returns `{ reason: 'error' }` without the Error — this bridges that gap.
  let lastRunnerError: Error | undefined;
  runner.on('done', (_reason: string, error?: Error) => { lastRunnerError = error; });

  // Durable compaction (off the hot path): when the in-memory compaction fires,
  // persist a boundary + summary so the NEXT run starts compacted — cross-run
  // cost reduction. Runs over DB rows in the background; never blocks the run.
  // The in-flight guard avoids overlapping summary calls during a long run.
  let durableInFlight = false;
  runner.on('history_compacted', (p) => {
    if (p.strategy !== 'summarizer') return;
    if (!durableCompactionEnabled() || runner.isSubagent || session.id == null) return;
    if (durableInFlight) return;
    durableInFlight = true;
    void runDurableCompaction({ store, sessionId: session.id, provider })
      .catch((e) => console.warn(`[coder] durable compaction failed for session ${session.id}:`, e))
      .finally(() => { durableInFlight = false; });
  });

  // Phase-route skip summary handler removed along with PhaseRouter.

  // Fire the caller's pre-run hook so they can attach listeners that
  // must observe the FIRST turn. Critical for company HumanInTheLoop
  // (`question_posted` from a master that calls `ask_user` on turn 1).
  // See `RunCoderOptions.onRunnerReady` for the contract.
  if (opts.onRunnerReady) {
    opts.onRunnerReady(runner);
  }

  // Permission gate — pauses write/execute/admin tool calls for user
  // approval depending on the session mode. Lives on the SHARED toolContext
  // object (the runner holds the same reference), so the main dispatch,
  // code_exec nested calls and subagent context copies all consult ONE
  // instance. Mode is read live from the runner, so PATCH
  // /tool-permission-mode applies mid-run to the next gated call.
  {
    let initialGrants: string[] = [];
    try {
      const parsed: unknown = JSON.parse(session.tool_permission_grants ?? '[]');
      if (Array.isArray(parsed)) initialGrants = parsed.filter((g): g is string => typeof g === 'string');
    } catch { /* corrupted grants column — start empty */ }
    toolContext.permissionGate = new PermissionGate({
      getMode: () => runner.getToolPermissionMode(),
      emit: (event, payload) => { runner.emit(event, payload as never); },
      waitForUserInput: (askId) => runner.waitForUserInput(askId),
      initialGrants,
      onGrant: (toolName) => {
        try {
          store.addToolPermissionGrant(session.id, toolName);
        } catch (e) {
          console.warn(`[coder] addToolPermissionGrant failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      // Keep-alive while approvals are pending so the stuck-running
      // watchdog (10 min) doesn't flip the session to idle mid-pause.
      onPendingTick: () => {
        try { store.touchSession(session.id); } catch { /* best-effort */ }
      },
    });
  }

  // Close the recorder ↔ runner loop now that both exist. The recorder
  // reads `runnerRef?.turn` lazily so writes captured inside `runner.run()`
  // are stamped with the right turn number.
  runnerRef = runner;

  // Durable-memory write-back (off the hot path). Reuses the structured
  // summarizer to assemble the distiller signal from the finished run, then
  // hands it to the host `runEndMemory` callback (positive facts + `gotcha`
  // failure lessons). Best-effort; only meaningful when the host wired a
  // writer and the project has memory enabled.
  const captureRunEndMemory = async (succeeded: boolean): Promise<void> => {
    const summary = await summarizeSpanV2(runner.messages, provider);
    if (!summary) return;
    // Recipe steps come only from a successful run's clean (non-error) commands.
    const toolTrail = succeeded
      ? store.getCommandTrail(session.id).filter((c) => !c.isError).map((c) => c.command)
      : [];
    await opts.runEndMemory!.extractAndPersist(project.id, project.name, {
      primaryRequest: summary.primary_request || undefined,
      summary: renderSummaryV2(summary),
      filesTouched: summary.files_and_code.map((f) => f.path).filter(Boolean),
      errorsAndFixes: summary.errors_and_fixes,
      toolTrail,
      succeeded,
    });
  };

  const donePromise = runner
    .run()
    .then(async (res) => {
      await flushPendingTurn();
      store.updateSessionStatus(session.id, res.reason === 'error' ? 'error' : 'idle');
      // Distill durable memory BEFORE `.finally` closes the DB handles. Errored-
      // but-resolved runs are included on purpose — that's where `gotcha`
      // lessons come from. Time-bounded so a stalled LLM can't pin handles open.
      if (
        opts.runEndMemory &&
        db.getProjectMemoryEnabled(project.id) &&
        runner.messages.length >= 4 &&
        (await opts.runEndMemory.isConfigured())
      ) {
        const succeeded = res.reason !== 'error' && store.didRunSucceed(session.id);
        await Promise.race([
          captureRunEndMemory(succeeded).catch(() => undefined),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            (timer as { unref?: () => void }).unref?.();
          }),
        ]);
      }
      return { reason: res.reason, usage: res.totalUsage, error: lastRunnerError?.message };
    })
    .catch(async (e) => {
      await flushPendingTurn();
      store.updateSessionStatus(session.id, 'error');
      throw e;
    })
    .finally(async () => {
      // Drain any pending async writes for THIS session before closing the
      // local DB handles. The writer is a process-wide singleton with its
      // own connection — it is not closed here, only on process shutdown.
      if (dbWriter) await dbWriter.drainSession(session.id);
      await mcpServerManager.closeAll();
      await bridge.close();
      for (const b of extraBridges) await b.close();
      store.close();
      try { skillStore.close(); } catch { /* best-effort */ }
      db.close();
    });

  return { session, runner, done: donePromise, indexStatus };
}

/**
 * Extract file-shaped tokens from arbitrary text (typically the user's
 * message). Used by the skills 'matched' mode to feed `recentFiles` into
 * the matcher when no formal file context is available — relative paths
 * and `*.ext` mentions are good enough for path-glob triggers.
 *
 * Pure heuristic; misses are fine — when the matcher returns empty, we
 * degrade to the lazy section instead of dumping every skill.
 */
// Helpers moved to './index/helpers.ts': extractFilePathsFromText, defaultModelFor

// Re-export key types for consumers
export { SessionStore } from '@mcp/code-agent/sessions/store.js';
export type { CoderSession } from '@mcp/code-agent/sessions/types.js';
export type { CoderProviderName } from '@mcp/code-agent/providers/adapter.js';
/**
 * Backwards-compatible alias used by HTTP admin routes. Derived dynamically
 * from the unified registry — all kinds that declare `createCoder`.
 */
export { listCoderKinds as SUPPORTED_CODER_PROVIDERS } from '@mcp/services/providers/factory.js';
