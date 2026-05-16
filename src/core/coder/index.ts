import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { CodeIndexDB } from '../../store/db.js';
import { getDbWriter, isDbWriterEnabled, type DbWriter } from '../workers/dbWriter/client.js';
import { loadConfig } from '../../utils/config.js';
import { createCoderProvider } from '../providers/factory.js';
import type { ChatProvider, CoderProviderName } from './providers/adapter.js';
import { ToolRegistry } from './core/registry.js';
import { CoderRunner } from './core/runner.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { buildRepoMap, resolveRepoMapBudget } from './core/repo-map.js';
import { fsTools } from './tools/fs.js';
import { applyPatchTool } from './tools/apply-patch.js';
import { shellTools } from './tools/shell.js';
import { gitTools } from './tools/git.js';
import {
  defaultLocalFilesystemPort,
  defaultLocalShellPort,
  SnapshotRecorder,
  SnapshotRecordingFilesystemPort,
} from './ports/index.js';
import { SessionFileSnapshotStore } from '../../store/session-file-snapshot-store.js';
import { SandboxFilesystemAdapter } from '../sandbox/adapters/sandbox-filesystem-adapter.js';
import { SandboxShellAdapter } from '../sandbox/adapters/sandbox-shell-adapter.js';
import { planTools } from './tools/plan.js';
import { tasksTools, executeTask, taskComplete } from './tools/tasks.js';
import { interactionTools } from './tools/interaction.js';
import { buildExpandTools } from './tools/expand.js';
import { buildFindToolsTool } from './tools/find-tools.js';
import { buildRequestReviewTool } from './tools/request-review.js';
import { McpToolBridge } from './tools/mcp-bridge.js';
import { buildMcpResourceTools } from './tools/mcp-resources.js';
import { McpServerManager } from './tools/mcp-server-manager.js';
import { McpServerStore } from '../../store/mcp-server-store.js';
import { buildSubagentTool, buildSpawnAgentsTool } from './tools/subagent.js';
import { buildSpawnAgentTool } from './tools/spawn-agent.js';
import { buildMasterTools } from './tools/company/master-tools.js';
import { buildKanbanTools } from './tools/company/kanban-tools.js';
import { buildBoardTools } from './tools/company/board-tools.js';
import { buildQaTools } from './tools/company/qa/index.js';
import { buildDesignSystemTools } from './tools/company/design-system/index.js';
import { buildSubordinateTools } from './tools/company/subordinate-tools.js';
import { buildSharedDriveTools } from './tools/company/shared-drive-tools.js';
import { sandboxTools } from './tools/company/sandbox-tools.js';
import { docsTools } from './tools/company/docs-tools.js';
import { envTools } from './tools/company/env-tools.js';
import { databaseTools } from './tools/company/database-tools.js';
import { buildSubordinateKanbanTools } from './tools/company/subordinate-kanban-tools.js';
import { isMasterAllowed } from './tools/company/master-filter.js';
import { RuntimeHookRegistry } from './core/hook-registry.js';
import { registerCompanyHooks } from './core/company-hooks.js';
import { inferProfileFromMessage, inferProfileFromHistory, profileToTiers, type CoderProfile } from './tools/tiers.js';
import { AGENTS, isAgentId, type AgentId } from './agents/index.js';
import { SessionOverlay } from './overlay/session-overlay.js';
import { ToolOutputStore } from './overlay/tool-output-store.js';
import { toolOutputTools } from './tools/tool-output.js';
import { diagnosticsTools } from './tools/diagnostics.js';
import { lspTools } from './tools/lsp.js';
import { ptyTools } from './tools/pty.js';
import { webTools } from './tools/web.js';
import { globTools } from './tools/glob.js';
import { todoTools, generateTodoId } from './tools/todo.js';
import { viewImageTools } from './tools/view-image.js';
import { goalTools } from './tools/goal.js';
import { buildCodeExecTool } from './tools/code-exec.js';
import { listAgentsTools } from './tools/list-agents.js';
import { waitAgentsTools } from './tools/wait-agents.js';
import { sendMessageTools } from './tools/send-message.js';
import { sendInputTools } from './tools/send-input.js';
import { worktreeTools, createProjectWorktree } from './tools/worktree.js';
import { SkillStore } from '../../store/skill-store.js';
import type { ResolvedSkill, SkillTemplateContext } from './skills/types.js';
import { buildInvokeSkillTool, buildSkillDiscoveryTools } from './skills/skill-tool-builder.js';
import { listInstalledNamespaces } from './skills/agent-skills-installer.js';
import {
  buildCompactSkillsSection,
  buildLazySkillsSection,
  buildMatchedSkillsPromptSection,
  buildSkillsPromptSection,
} from './skills/prompt-injector.js';
import { matchSkills, type SkillMatchContext } from './skills/skill-matcher.js';
import { SessionStore } from './sessions/store.js';
import { ProviderStore } from '../../store/provider-store.js';
import type { CoderSession } from './sessions/types.js';
import { attachmentsToBlocks, type AgentMessage, type ChatUsage } from './core/messages.js';
import type { ToolContext } from './core/tool.js';

export interface CoderAttachment {
  name: string;
  mediaType: string;
  /** Base64-encoded payload (for images and binary docs like PDF). */
  base64?: string;
  /** Pre-decoded UTF-8 text (for plain-text-like files). */
  text?: string;
}

export interface RunCoderOptions {
  /** Numeric session id (existing) or "new" to create one */
  session: { id: number } | { create: { project_id: number; title: string; provider: CoderProviderName; model?: string } };
  /** User message to append before running */
  userMessage: string;
  /** Optional attachments (images, documents) for the user message */
  attachments?: CoderAttachment[];
  /** Optional max turns (default 50) */
  maxTurns?: number;
  /** Abort signal */
  signal?: AbortSignal;
  /** Plan mode: agent must call submit_plan and get approval before mutating tools. */
  planMode?: boolean;
  /**
   * Agent preset — bundles profile + planMode + maxTurns for a common usage
   * pattern. Takes precedence over explicit `profile` / `planMode` when set.
   * See src/core/coder/agents/index.ts for the four built-in presets
   * (explore / plan / build / admin).
   */
  agent?: AgentId;
  /**
   * Tool tier profile. Restricts the tools array sent to the LLM on each turn.
   * - 'bootstrap' (~13 tools): read/search/pulse only — default for new sessions.
   * - 'navigate' (~33 tools): adds write/edit/git-read/deep nav. Default when
   *   the user message contains implement/refactor/fix/etc. keywords.
   * - 'full' (all 57 tools): legacy behaviour. Default for resumed sessions.
   * - 'auto': inferred from the first user message via a simple regex classifier.
   * The agent can unlock higher tiers mid-session via `expand_toolset`.
   */
  profile?: CoderProfile | 'auto';
  /**
   * Create and enter an isolated git worktree at session start. When set
   * on a fresh session (no prior `worktree_path` persisted), runCoder
   * creates `.mcp-indexer/worktrees/<name>/` and scopes the runner into
   * it BEFORE the first turn — so the agent sees the worktree as its cwd
   * from the very first tool call.
   *
   * - `name` (optional): worktree directory name. Auto-generated if omitted.
   * - `branch` (optional): branch to check out. Defaults to `coder/<name>`.
   *   Created from HEAD when it does not exist yet.
   *
   * The existing `enter_worktree` / `exit_worktree` admin-tier tools remain
   * available for mid-session pivots, but the primary path is to decide
   * "this session runs in a worktree" once at creation time.
   */
  worktree?: { name?: string; branch?: string };
  /**
   * Resume mode: do NOT push a new user message. Used when the dashboard
   * answered a pending submit_plan/ask_user after a server restart — the
   * tool_result was already appended to the DB by the API handler, and the
   * runner should pick up from existing history and run the next turn.
   */
  resume?: boolean;
  /** Enable thinking/reasoning mode for providers that support it. */
  thinking?: boolean;
  /** Company orchestrator context — when present, company tools are registered. */
  companyContext?: import('./company/types.js').CompanyContext;
  /** Extra system prompt block for company agents (master/subordinate). Appended to the base prompt. */
  companyPromptBlock?: string;
  /** Role identity text (from template systemPromptOverride) re-injected after compaction. */
  companyRoleOverride?: string;
  /**
   * Per-role sampling temperature override (`CompanyRoleConfig.temperature`).
   * Forwarded to `CoderRunner` and consumed by `resolveTemperature`. Lower
   * precedence than the per-session value but higher than the agent preset
   * default. Only meaningful for company subordinates.
   */
  roleTemperature?: number;
  /**
   * Resolver for OAuth bearer tokens of external MCP servers. When provided,
   * external servers with `auth_type='oauth2'` automatically receive
   * `Authorization: Bearer <access>` (with auto-refresh). When null/omitted,
   * OAuth servers connect unauthenticated — the dashboard then prompts the
   * user to complete the OAuth flow.
   */
  mcpBearerResolver?: import('../mcp-client/auth/use-cases/resolve-mcp-bearer.js').ResolveMcpBearer | null;
  /**
   * Phase 2 hardening: explicit escape hatch the policy module consults
   * when running in strict mode (Phase 5). Today this flag is reserved —
   * the runner builds its policy context with `strict: false` so the
   * adminOverride value has no observable effect on behaviour. Wired in
   * advance so the API surface is stable when strict mode is enabled.
   */
  adminOverride?: boolean;
  /**
   * Synchronous hook fired right after the `CoderRunner` is constructed
   * and all internal listeners are attached, but BEFORE `runner.run()`
   * is called. Callers register listeners that must observe the very
   * first turn — e.g. company HumanInTheLoop's `question_posted` /
   * `plan_posted` / `tasks_posted` capture, which would otherwise miss
   * an `ask_user` made on turn 1 because `runCoder` returns the handle
   * after the run loop has already started emitting.
   *
   * Multiple listeners can be wired here: this fires once. Errors thrown
   * here propagate (refuse to start the run with a broken wire-up).
   */
  onRunnerReady?: (runner: CoderRunner) => void;

  /**
   * Notification callback fired whenever the SnapshotRecorder captures
   * (or appends to) a baseline for a file the agent just mutated. Lets the
   * HTTP layer publish a `session_snapshot_changed` SSE event so the
   * dashboard can refresh the Snapshots tab live, without polling.
   *
   * Optional — when undefined, snapshot recording still happens, the
   * dashboard just has to pull on its own cadence.
   */
  onSnapshotRecorded?: (info: { baselineId: number; filePath: string }) => void;
}

export interface IndexStatus {
  isIndexed: boolean;
  mcpAvailable: boolean;
}

export interface RunCoderHandle {
  session: CoderSession;
  runner: CoderRunner;
  /** Awaits completion. Resolves with the run reason, usage, and optional error detail. */
  done: Promise<{ reason: string; usage: ChatUsage; error?: string }>;
  /** Whether the project is indexed and MCP tools were registered. */
  indexStatus: IndexStatus;
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
  // apply_patch is gated to ChatGPT/Codex sessions because it doubles up
  // with multi_edit/edit_file for other providers (no benefit, more tokens).
  // The Codex backend signals its preference via apply_patch_tool_type and
  // the chatgpt provider switches the wire shape to `type: 'custom'`.
  if (provider.name === 'chatgpt') {
    registry.register(applyPatchTool);
  }

  // Company subordinates get master-directed communication tools instead of
  // the human-facing ask_user / submit_plan / submit_tasks. The replacement
  // tools emit the same runner events so orchestrator interception is unchanged.
  if (opts.companyContext && !opts.companyContext.isMaster) {
    registry.registerAll(buildSubordinateTools());
    registry.register(executeTask);
    registry.register(taskComplete);
  } else {
    registry.registerAll(planTools);
    registry.registerAll(tasksTools);
    registry.registerAll(interactionTools);
  }
  // Builder-mode tools: offered to both master and subordinates in builder
  // sessions. The gate is on session configuration (`builderStack`) rather
  // than a live sandbox binding so the master can access env/database tools
  // even when the primary container is temporarily unavailable.
  // Tools that actually need a live container (sandboxTools, docsTools) are
  // still registered — they will return clear errors if called without one.
  if (opts.companyContext?.sandbox || opts.companyContext?.builderStack) {
    registry.registerAll(sandboxTools);
    // Docs tools write into `<workdir>/docs/` inside the container.
    // Registered for all builder sessions; fail gracefully when the
    // container is down so the agent gets a useful error message.
    registry.registerAll(docsTools);
    // Env tools manage session-shared env vars stored in the DB —
    // they work independently of any container being alive.
    registry.registerAll(envTools);
    // Database tools query Postgres/MySQL instances registered in the
    // Databases tab — DB-backed, do not require the sandbox container.
    registry.registerAll(databaseTools);
  }
  // expand_toolset registered AFTER external MCP servers (see below) so its
  // tier enum can include custom tiers dynamically.
  registry.registerAll(toolOutputTools);
  registry.registerAll(diagnosticsTools);
  registry.registerAll(lspTools);
  registry.registerAll(ptyTools);
  registry.registerAll(webTools);
  registry.registerAll(globTools);
  registry.registerAll(todoTools);
  registry.registerAll(viewImageTools);
  registry.registerAll(goalTools);
  registry.registerAll(listAgentsTools);
  registry.registerAll(waitAgentsTools);
  registry.registerAll(sendMessageTools);
  registry.registerAll(sendInputTools);
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
  const mcpServerManager = new McpServerManager(opts.mcpBearerResolver ?? null);
  let externalToolTiers: ReadonlyMap<string, import('./tools/tiers.js').ToolTier> | undefined;
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
          const subTierMap = new Map<string, import('./tools/tiers.js').ToolTier>();
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

  // Subagent tool — registered AFTER MCP tools so it can snapshot the full
  // tool list for the explore allowlist. Disabled via CODER_DISABLE_SUBAGENTS=1.
  // Subagent tools — DISABLED for company Master. The Master must use
  // spawn_subordinate_agent (persistent company sessions) instead of
  // spawn_agents/spawn_subagent (ephemeral read-only subagents).
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
        subagentProvider = await createCoderProvider(targetProviderId, targetModel);
        console.log(
          `[coder] subagent provider override: ${targetProviderId}:${subagentProvider.model}`,
        );
      }
    } catch { /* non-fatal — falls back to parent provider */ }

    const subagentDeps = { provider, parentTools, sessionStore: store, subagentProvider };
    registry.register(buildSubagentTool(subagentDeps));
    registry.register(buildSpawnAgentsTool(subagentDeps));
  }

  // Company tools — registered when this runner is part of a company session.
  if (opts.companyContext) {
    const { orchestrator, agentRole, isMaster, agentRunId } = opts.companyContext;
    registry.registerAll(buildBoardTools(orchestrator, agentRole, agentRunId));
    // Shared drive: persistent file pool scoped to the company template,
    // visible to master and every subordinate. Lets agents exchange large
    // documents without inflating board posts or inbox messages.
    registry.registerAll(buildSharedDriveTools());
    // Subordinate kanban tools: self-service card updates (comment, checklist, move-to-review)
    if (!isMaster && agentRunId != null) {
      registry.registerAll(buildSubordinateKanbanTools(orchestrator, agentRole, agentRunId));
      // QA tools: gated by skill (qa-playwright) via the skill's allowed-tools.
      // The tool is harmless when not used, so we register unconditionally for
      // subordinates and let the prompt-injector instructions discipline usage.
      registry.registerAll(buildQaTools(orchestrator, agentRole, agentRunId));
      // Design System Creator tools: same pattern — gated by per-skill
      // allowed-tools (ds-extractor, ds-components-*, ds-mcp-server, ds-docs).
      registry.registerAll(buildDesignSystemTools(orchestrator, agentRole, agentRunId));
    }
    if (isMaster) {
      registry.registerAll(buildMasterTools(orchestrator));
      registry.registerAll(buildKanbanTools(orchestrator));
      // Master also gets the DS publish/status tools (it owns the publish step).
      registry.registerAll(buildDesignSystemTools(orchestrator, agentRole, agentRunId));
      // Strip code-level tools from Master — it should only orchestrate, not read code
      registry.filterInPlace(isMasterAllowed);
      console.log(`[coder] Master: filtered to ${registry.list().length} tools (orchestration-only)`);
    }
    // Diagnostic log of DS tool count post-registration. Lets the operator
    // distinguish "tool missing from registry" (this log shows 0) from
    // "model didn't call tool" (log shows 4) when a round goes wrong.
    const dsCount = registry.list().filter((t) => t.name.startsWith('ds_')).length;
    if (dsCount > 0) {
      console.log(
        `[coder] DS tools registered for ${isMaster ? 'master' : `subordinate (${agentRole})`}: ${dsCount}`,
      );
    }
  }

  // Unified spawn dispatcher — registered after BOTH spawn_subagent (always,
  // when subagents are enabled) and spawn_subordinate_agent (master-only).
  // Resolution is lazy at call time, so kind="ephemeral" works in any
  // session that has spawn_subagent registered, and kind="persistent" works
  // only when spawn_subordinate_agent is in the registry.
  if (registry.get('spawn_subagent') || registry.get('spawn_subordinate_agent')) {
    registry.register(buildSpawnAgentTool(registry));
  }

  // Builder mode: when the company context carries a sandbox binding,
  // we pin `cwd` to the container workdir and swap the default ports
  // for sandbox-backed adapters. Every filesystem/shell tool from here
  // on transparently talks to the container — no conditional in the
  // tool code. The host `project.root_path` is ignored because there
  // is no host-side project in builder mode (yet).
  const sandboxBinding = opts.companyContext?.sandbox;
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
  const effectiveCwd = sandboxBinding
    ? sandboxBinding.workdir
    : resolvePath(project.root_path);
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
  let runnerRef: import('./core/runner.js').CoderRunner | null = null;
  const recorder = new SnapshotRecorder({
    sessionKind: 'coder',
    sessionId: session.id,
    projectRoot: resolvePath(project.root_path),
    store: snapshotStore,
    getTurn: () => runnerRef?.turn ?? null,
    onRecorded: opts.onSnapshotRecorded,
  });
  const fsPort = new SnapshotRecordingFilesystemPort(rawFsPort, recorder);

  const toolContext: ToolContext = {
    cwd: effectiveCwd,
    projectName: project.name,
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
    companyContext: opts.companyContext,
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
  const hasHistory0 = initialMessagesEarly.length > 0;

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
  let resolvedSkills: ResolvedSkill[] = [];
  try {
    const skillStore = new SkillStore(config.dbPath);
    resolvedSkills = skillStore.resolveActiveSkills(session.id, session.project_id);
    skillStore.close();
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
  });

  // Append company prompt block (master orchestration or subordinate instructions)
  if (opts.companyPromptBlock) {
    systemPrompt += '\n' + opts.companyPromptBlock;
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

  // Reuse the history we loaded early for profile resolution.
  const initialMessages: AgentMessage[] = initialMessagesEarly;

  const activeTiers = profileToTiers(preResolvedProfile);
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
    const FILE_WRITE_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit']);
    const pending = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_WRITE_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const raw = ctx.toolArgs.path ?? ctx.toolArgs.file_path ?? '';
      const path = typeof raw === 'string' ? raw : String(raw);
      if (path) pending.add(path);
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
    const FILE_MUTATING_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'multi_edit']);
    hookRegistry.onToolCall('after', (ctx) => {
      if (!FILE_MUTATING_TOOLS.has(ctx.toolName)) return;
      if (ctx.result?.isError) return;
      const raw = ctx.toolArgs.path ?? ctx.toolArgs.file_path ?? '';
      const rawStr = typeof raw === 'string' ? raw : String(raw);
      if (!rawStr) return;
      // Normalize to the same shape the scanner stores in `files.path`:
      // forward slashes, no leading `./`, no trailing slash. Without this,
      // `db.getFile(projectId, relPath)` misses on Windows (backslashes) or
      // when the agent passes `./src/foo.ts`, and the tree-sitter refresh
      // is silently skipped.
      const relPath = rawStr.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      // Async, non-blocking. We re-import to avoid pulling tree-sitter wasm
      // into sessions that never edit code.
      void (async () => {
        try {
          const { indexFileNow } = await import('../indexer/incremental.js');
          const { resolve: resolveAbs } = await import('node:path');
          const abs = resolveAbs(toolContext.cwd, relPath);
          const content = await (toolContext.ports?.fs ?? defaultLocalFilesystemPort()).readFile(abs);
          await indexFileNow(db, project.id, relPath, content);
        } catch {
          // best-effort — never crash on incremental refresh failures
        }
      })();
    });
  }

  // ─── Fallback chain ───────────────────────────────────────────
  // Always defined so the runner can refresh OAuth credentials (e.g. the
  // Copilot 25-min token) on 401 even when no fallback chain is configured.
  const createProviderForFallback = async (name: string, model: string) => {
    return createCoderProvider(name, model);
  };
  let fallbackChain: import('./core/fallback.js').FallbackChain | undefined;
  try {
    const { buildFallbackChain } = await import('./core/fallback.js');
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
    const { getRegistryContextWindow } = await import('./providers/capabilities.js');
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

  const runner = new CoderRunner({
    provider,
    registry,
    systemPrompt,
    toolContext,
    initialMessages,
    sessionId: session.id,
    sessionStore: store,
    // (assignment below) — keeps recorder in sync with runner.turn
    // even though the runner is constructed after recorder. The recorder
    // reads `runnerRef?.turn` lazily, so this assignment closes the loop.
    maxTurns: opts.maxTurns ?? 50,
    planMode: opts.planMode,
    thinking: opts.thinking,
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
    adminOverride: opts.adminOverride,
    agentId: effectiveAgentId,
    sessionTemperature: session.temperature_override,
    roleTemperature: opts.roleTemperature,
    // Per-session unrestricted-tool-output toggle (migration 078). Lifts the
    // per-block PUSH_TIME_CAP to the high safety ceiling so verbose MCP tools
    // (Unity, large file reads, batched code_exec) arrive intact.
    unrestrictedToolOutput: !!session.unrestricted_tool_output,
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
  });

  // Rehydrate the lightweight todo list from the DB so a session resume
  // brings back the sidebar state the user saw before the restart.
  if (session.todos_json) {
    try {
      const parsed = JSON.parse(session.todos_json) as Array<Partial<import('./tools/todo.js').TodoItem>>;
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
    runner.pushUserContent(userBlocks);
    store.appendMessage(session.id, { role: 'user', content: userBlocks });
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
  let lastToolMessageId: number | null = null;
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
      output_chars: content.length,
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

  // The runner pushes a single 'tool' role message after running all tool calls
  // for the turn. We need to persist that too. Hook done to flush the latest one.
  // Easiest: peek at runner.messages after the turn — but we don't have a per-turn
  // event. Instead, persist the tool message right before each new turn_start.
  // The runner starts with initialMessages loaded from the DB — those are
  // already persisted. Skip past them so flushToolMessages only persists
  // tool messages produced *during this run*. Before this fix,
  // lastPersistedIdx was 0 for non-resume runs, causing every tool message
  // from history to be re-appended on the first turn_start — exponential
  // duplication across turns and forks.
  let lastPersistedIdx = runner.messages.length;
  const flushToolMessages = () => {
    for (let i = lastPersistedIdx; i < runner.messages.length; i++) {
      const m = runner.messages[i];
      if (m.role === 'tool') {
        const id = store.appendMessage(session.id, m);
        lastToolMessageId = id;
      }
    }
    lastPersistedIdx = runner.messages.length;
  };
  // Order matters: flush the assistant turn (message + tool rows) BEFORE the
  // 'tool' role message, so the FK chain stays consistent on resume.
  runner.on('turn_start', () => {
    void flushPendingTurn();
    flushToolMessages();
  });

  // Capture the last error emitted by the runner so we can propagate it
  // through the done promise. The runner emits `done('error', Error)` but
  // `run()` returns `{ reason: 'error' }` without the Error — this bridges that gap.
  let lastRunnerError: Error | undefined;
  runner.on('done', (_reason: string, error?: Error) => { lastRunnerError = error; });

  // Phase-route skip summary handler removed along with PhaseRouter.

  // Fire the caller's pre-run hook so they can attach listeners that
  // must observe the FIRST turn. Critical for company HumanInTheLoop
  // (`question_posted` from a master that calls `ask_user` on turn 1).
  // See `RunCoderOptions.onRunnerReady` for the contract.
  if (opts.onRunnerReady) {
    opts.onRunnerReady(runner);
  }

  // Close the recorder ↔ runner loop now that both exist. The recorder
  // reads `runnerRef?.turn` lazily so writes captured inside `runner.run()`
  // are stamped with the right turn number.
  runnerRef = runner;

  const donePromise = runner
    .run()
    .then(async (res) => {
      await flushPendingTurn();
      flushToolMessages();
      store.updateSessionStatus(session.id, res.reason === 'error' ? 'error' : 'idle');
      return { reason: res.reason, usage: res.totalUsage, error: lastRunnerError?.message };
    })
    .catch(async (e) => {
      await flushPendingTurn();
      flushToolMessages();
      store.updateSessionStatus(session.id, 'error');
      throw e;
    })
    .finally(async () => {
      void lastToolMessageId; // silence unused
      // Drain any pending async writes for THIS session before closing the
      // local DB handles. The writer is a process-wide singleton with its
      // own connection — it is not closed here, only on process shutdown.
      if (dbWriter) await dbWriter.drainSession(session.id);
      await mcpServerManager.closeAll();
      await bridge.close();
      for (const b of extraBridges) await b.close();
      store.close();
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
function extractFilePathsFromText(text: string): string[] {
  if (!text) return [];
  const paths = new Set<string>();
  // Tokens that look like a file path (with at least one slash or a dotted
  // extension) — non-greedy to avoid swallowing surrounding prose.
  const re = /(?:[a-zA-Z0-9_\-./@]+\/)?[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]{1,8}\b/g;
  for (const m of text.matchAll(re)) {
    paths.add(m[0]);
    if (paths.size >= 20) break;
  }
  return [...paths];
}

function defaultModelFor(provider: CoderProviderName): string {
  switch (provider) {
    case 'anthropic':
    case 'claude-code':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o-mini';
    case 'zai':
      return 'glm-5.1';
    case 'deepseek':
      return 'deepseek-chat';
    case 'kimi-code':
      return 'kimi-k2.6';
    case 'gemini':
      // 2.5-flash is the current free-tier model; 2.0-flash has its free
      // quota set to 0 as of April 2026 and returns 429 immediately.
      return 'gemini-2.5-flash';
  }
}

// Re-export key types for consumers
export { SessionStore } from './sessions/store.js';
export type { CoderSession } from './sessions/types.js';
export type { CoderProviderName } from './providers/adapter.js';
/**
 * Backwards-compatible alias used by HTTP admin routes. Derived dynamically
 * from the unified registry — all kinds that declare `createCoder`.
 */
export { listCoderKinds as SUPPORTED_CODER_PROVIDERS } from '../providers/factory.js';
