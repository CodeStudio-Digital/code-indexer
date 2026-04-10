import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { CodeIndexDB } from '../../store/db.js';
import { loadConfig } from '../../utils/config.js';
import { createChatProviderAsync } from './providers/factory.js';
import type { CoderProviderName } from './providers/adapter.js';
import { ToolRegistry } from './core/registry.js';
import { CoderRunner } from './core/runner.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { fsTools } from './tools/fs.js';
import { shellTools } from './tools/shell.js';
import { gitTools } from './tools/git.js';
import { planTools } from './tools/plan.js';
import { tasksTools } from './tools/tasks.js';
import { interactionTools } from './tools/interaction.js';
import { buildExpandTools } from './tools/expand.js';
import { McpToolBridge } from './tools/mcp-bridge.js';
import { McpServerManager } from './tools/mcp-server-manager.js';
import { McpServerStore } from '../../store/mcp-server-store.js';
import { buildSubagentTool, buildSpawnAgentsTool } from './tools/subagent.js';
import { buildMasterTools } from './tools/company/master-tools.js';
import { buildBoardTools } from './tools/company/board-tools.js';
import { inferProfileFromMessage, profileToTiers, type CoderProfile } from './tools/tiers.js';
import { AGENTS, type AgentId } from './agents/index.js';
import { SessionOverlay } from './overlay/session-overlay.js';
import { ToolOutputStore } from './overlay/tool-output-store.js';
import { toolOutputTools } from './tools/tool-output.js';
import { diagnosticsTools } from './tools/diagnostics.js';
import { lspTools } from './tools/lsp.js';
import { ptyTools } from './tools/pty.js';
import { webTools } from './tools/web.js';
import { globTools } from './tools/glob.js';
import { todoTools } from './tools/todo.js';
import { worktreeTools, createProjectWorktree } from './tools/worktree.js';
import { SkillStore } from '../../store/skill-store.js';
import type { ResolvedSkill, SkillTemplateContext } from './skills/types.js';
import { buildInvokeSkillTool } from './skills/skill-tool-builder.js';
import { SessionStore } from './sessions/store.js';
import { ProviderStore } from '../../store/provider-store.js';
import type { CoderSession } from './sessions/types.js';
import type { AgentMessage, ChatUsage, ContentBlock } from './core/messages.js';
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
  /** Company orchestrator context — when present, company tools are registered. */
  companyContext?: import('./company/types.js').CompanyContext;
  /** Extra system prompt block for company agents (master/subordinate). Appended to the base prompt. */
  companyPromptBlock?: string;
}

export interface RunCoderHandle {
  session: CoderSession;
  runner: CoderRunner;
  /** Awaits completion. Resolves with the run reason and usage. */
  done: Promise<{ reason: string; usage: ChatUsage }>;
}

/**
 * Build a fully-wired runner for a coder session and start it.
 *
 * Both the CLI and the SSE handler use this. Listeners should be attached
 * to `handle.runner` BEFORE awaiting `handle.done`.
 */
export async function runCoder(opts: RunCoderOptions): Promise<RunCoderHandle> {
  // Agent preset: when provided, its profile/planMode/maxTurns override
  // unspecified opts but leave explicit ones alone. This way `--agent build
  // --plan` means "build defaults EXCEPT plan mode forced on".
  const agentDef = opts.agent ? AGENTS[opts.agent] : null;
  if (agentDef) {
    if (opts.profile === undefined) opts = { ...opts, profile: agentDef.profile };
    if (opts.planMode === undefined) opts = { ...opts, planMode: agentDef.planMode };
    if (opts.maxTurns === undefined && agentDef.maxTurns) opts = { ...opts, maxTurns: agentDef.maxTurns };
  }
  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const store = new SessionStore(config.dbPath);

  // Resolve or create the session
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
    });
  }

  const project = db.getProject(session.project_id);
  if (!project) throw new Error(`Project ${session.project_id} not found`);

  // Provider — async path so Copilot tokens get refreshed before the run.
  const provider = await createChatProviderAsync(session.provider as CoderProviderName, session.model);

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
  registry.registerAll(planTools);
  registry.registerAll(tasksTools);
  registry.registerAll(interactionTools);
  // expand_toolset registered AFTER external MCP servers (see below) so its
  // tier enum can include custom tiers dynamically.
  registry.registerAll(toolOutputTools);
  registry.registerAll(diagnosticsTools);
  registry.registerAll(lspTools);
  registry.registerAll(ptyTools);
  registry.registerAll(webTools);
  registry.registerAll(globTools);
  registry.registerAll(todoTools);
  registry.registerAll(worktreeTools);

  const bridge = new McpToolBridge();
  try {
    await bridge.connect();
    const mcpTools = await bridge.listTools({ projectName: project.name, overlay });
    registry.registerAll(mcpTools);
  } catch (e) {
    console.warn(`[coder] MCP bridge failed to connect: ${e instanceof Error ? e.message : String(e)}`);
  }

  // External MCP servers — configured via admin panel (migration 015).
  // Connected AFTER internal bridge so external tools are at the tail of the
  // registry, meaning they are trimmed first when the model tool cap kicks in.
  const mcpServerManager = new McpServerManager();
  let externalToolTiers: ReadonlyMap<string, import('./tools/tiers.js').ToolTier> | undefined;
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
      }
    }
    mcpServerStore.close();
  } catch (e) {
    console.warn(`[coder] External MCP servers failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // expand_toolset — registered AFTER external servers so the tier enum
  // includes any custom tiers (e.g., "cloudflare", "github") from connected servers.
  const customTierSummary = mcpServerManager.getCustomTierSummary();
  registry.registerAll(buildExpandTools(customTierSummary.size > 0 ? customTierSummary : undefined));

  // Subagent tool — registered AFTER MCP tools so it can snapshot the full
  // tool list for the explore allowlist. Disabled via CODER_DISABLE_SUBAGENTS=1.
  if (process.env.CODER_DISABLE_SUBAGENTS !== '1') {
    const subagentDeps = { provider, parentTools: registry.list() };
    registry.register(buildSubagentTool(subagentDeps));
    registry.register(buildSpawnAgentsTool(subagentDeps));
  }

  // Company tools — registered when this runner is part of a company session.
  if (opts.companyContext) {
    const { orchestrator, agentRole, isMaster, agentRunId } = opts.companyContext;
    registry.registerAll(buildBoardTools(orchestrator, agentRole, agentRunId));
    if (isMaster) {
      registry.registerAll(buildMasterTools(orchestrator));
    }
  }

  const toolContext: ToolContext = {
    cwd: resolvePath(project.root_path),
    projectName: project.name,
    overlay,
    toolOutputStore,
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
        store.updateTaskStatus(session.id, taskId, patch);
      } catch (e) {
        console.warn(`[coder] updateTaskStatus failed: ${e instanceof Error ? e.message : String(e)}`);
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
  // 'bootstrap' for fresh sessions, 'full' for resumed ones. Resumed sessions
  // skip tier filtering because the stored history may already reference
  // tools from higher tiers — hiding them now would confuse the model.
  const rawProfile0 =
    opts.profile ??
    (process.env.CODER_PROFILE as CoderProfile | 'auto' | undefined) ??
    (hasHistory0 ? 'full' : 'bootstrap');
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

  // Register invoke_skill tool if any tool-mode skills exist
  const toolModeSkills = resolvedSkills.filter(
    (s) => s.contextMode === 'tool' || s.contextMode === 'both',
  );
  if (toolModeSkills.length > 0) {
    const skillTemplateCtx: SkillTemplateContext = {
      PROJECT_NAME: project.name,
      PROJECT_ROOT: project.root_path,
      SESSION_ID: String(session.id),
      OS: process.platform,
      TIMESTAMP: new Date().toISOString(),
    };
    registry.register(
      buildInvokeSkillTool(toolModeSkills, skillTemplateCtx, config.dbPath, session.id),
    );
  }

  let systemPrompt = buildSystemPrompt({
    projectName: project.name,
    projectRoot: project.root_path,
    os: process.platform,
    planMode: opts.planMode,
    providerFamily: session.provider as CoderProviderName,
    profile: preResolvedProfile,
    skills: resolvedSkills.length > 0 ? resolvedSkills : undefined,
    sessionId: String(session.id),
    customTiers: customTierSummary.size > 0
      ? [...customTierSummary.entries()].map(([tier, info]) => ({
          tier,
          displayName: info.displayName,
          toolCount: info.toolCount,
        }))
      : undefined,
  });

  // Append company prompt block (master orchestration or subordinate instructions)
  if (opts.companyPromptBlock) {
    systemPrompt += '\n' + opts.companyPromptBlock;
  }

  // Reuse the history we loaded early for profile resolution.
  const initialMessages: AgentMessage[] = initialMessagesEarly;

  const activeTiers = profileToTiers(preResolvedProfile);
  if (process.env.CODER_LOG_TOOLS_COUNT === '1') {
    console.log(
      `[coder] profile=${preResolvedProfile} active_tiers=${Array.from(activeTiers).sort().join(',')}`,
    );
  }

  // Load disabled tools (global from admin panel + session-level overrides)
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

  const runner = new CoderRunner({
    provider,
    registry,
    systemPrompt,
    toolContext,
    initialMessages,
    maxTurns: opts.maxTurns ?? 50,
    planMode: opts.planMode,
    activeTiers,
    globalDisabledTools,
    sessionDisabledTools: sessionDisabledTools.size > 0 ? sessionDisabledTools : undefined,
    externalToolTiers,
  });

  // Rehydrate the lightweight todo list from the DB so a session resume
  // brings back the sidebar state the user saw before the restart.
  if (session.todos_json) {
    try {
      const parsed = JSON.parse(session.todos_json) as import('./tools/todo.js').TodoItem[];
      if (Array.isArray(parsed)) {
        // Bypass the event emitter on rehydrate — the runner isn't listening
        // yet and we don't want to double-persist on startup.
        runner.currentTodos = parsed.map((t) => ({ ...t }));
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
    // Build user content blocks: text first, then attachments
    const userBlocks: ContentBlock[] = [{ type: 'text', text: opts.userMessage }];
    for (const att of opts.attachments ?? []) {
      if (att.mediaType.startsWith('image/') && att.base64) {
        userBlocks.push({ type: 'image', mediaType: att.mediaType, base64: att.base64 });
      } else {
        userBlocks.push({
          type: 'document',
          name: att.name,
          mediaType: att.mediaType,
          text: att.text,
          base64: att.base64,
        });
      }
    }
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
  // so we capture the message id at message_complete time.
  let lastAssistantMessageId: number | null = null;
  let lastToolMessageId: number | null = null;
  const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  runner.on('tool_call_start', (id, name, input) => {
    pendingToolCalls.set(id, { name, input });
  });

  runner.on('message_complete', (message, usage) => {
    if (message.role === 'assistant') {
      lastAssistantMessageId = store.appendMessage(session.id, message, usage ?? undefined);
      if (usage) {
        store.bumpUsage(
          session.id,
          usage.input_tokens,
          usage.output_tokens,
          usage.cache_read_input_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0,
        );
      }
    }
  });

  runner.on('tool_call_result', (id, name, result, durationMs) => {
    if (lastAssistantMessageId === null) return;
    const pending = pendingToolCalls.get(id);
    store.appendToolCall({
      message_id: lastAssistantMessageId,
      tool_use_id: id,
      tool_name: name,
      args: pending?.input ?? {},
      result_text: result.content,
      is_error: Boolean(result.isError),
      duration_ms: durationMs,
    });
    // Subagent usage must show up in the session counters too — otherwise
    // the dashboard would mask the real cost of delegated work.
    if (result.subUsage) {
      store.bumpUsage(
        session.id,
        result.subUsage.input_tokens,
        result.subUsage.output_tokens,
        result.subUsage.cache_read_input_tokens ?? 0,
        result.subUsage.cache_creation_input_tokens ?? 0,
      );
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
  runner.on('turn_start', flushToolMessages);

  const donePromise = runner
    .run()
    .then((res) => {
      flushToolMessages();
      store.updateSessionStatus(session.id, res.reason === 'error' ? 'error' : 'idle');
      return { reason: res.reason, usage: res.totalUsage };
    })
    .catch((e) => {
      store.updateSessionStatus(session.id, 'error');
      throw e;
    })
    .finally(async () => {
      void lastToolMessageId; // silence unused
      await mcpServerManager.closeAll();
      await bridge.close();
      store.close();
      db.close();
    });

  return { session, runner, done: donePromise };
}

function defaultModelFor(provider: CoderProviderName): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o-mini';
    case 'zai':
      return 'glm-5.1';
    case 'deepseek':
      return 'deepseek-chat';
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
export { SUPPORTED_CODER_PROVIDERS } from './providers/factory.js';
