/**
 * Generalized subagent runner — extracted from src/coder/tools/subagent.ts so
 * that both the read-only `spawn_subagent` (explore) flow AND the new
 * `execute_task` mode='subagent' flow can spin up isolated CoderRunners with
 * a curated tool registry, parameterized system prompt, and (optionally) a
 * path scope for filesystem/shell tools.
 *
 * The implement-subagent variant additionally:
 *   - whitelists write_file/edit_file/create_file/run_command;
 *   - wraps fs/shell tools with a path-scope sandbox that LOGS (warning mode)
 *     reads/writes outside the declared task files but DOES NOT block them;
 *   - parses a structured `<result>{...}</result>` block from the subagent's
 *     final assistant message into a TaskResult.
 *
 * The wrapper deliberately uses warning mode instead of strict blocking
 * because subagents can have legitimate reasons to read an imported file
 * outside the declared scope (e.g. to look at a type definition). The parent
 * orchestrator gets the violation list in the TaskResult and can decide.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { CoderRunner, SUBAGENT_TOOL_RESULT_CAP, extractPathsFromToolArgs, isPathInsideScope } from '@mcp/code-agent/core/runner.js';
import type { CoderTask, TaskResult, TaskReference } from '@mcp/code-agent/sessions/types.js';

/**
 * Tool filter for a subagent. Three shapes:
 *   - `Set<string>` — legacy allowlist by tool name. Matches the static
 *     EXPLORE_ALLOWLIST / IMPLEMENT_ALLOWLIST tables below.
 *   - `(tool) => boolean` — predicate. Lets callers admit dynamic groups
 *     like "all MCP externos that aren't mutating" without enumerating
 *     names ahead of time.
 *   - `null` — full access. Subagent inherits the parent registry as-is.
 */
export type SubagentAllowlist =
  | Set<string>
  | ((tool: CoderTool) => boolean)
  | null;

export interface SubagentSpec {
  systemPrompt: string;
  allowlist: SubagentAllowlist;
  initialMessages: AgentMessage[];
  maxTurns: number;
  pushTimeCap?: number;
  /** When set, fs/shell tools log (do not block) reads/writes outside this list. */
  pathScope?: string[];
}

/** Helper: tests whether a tool is admitted by the given allowlist shape. */
function isAllowed(allowlist: SubagentAllowlist, tool: CoderTool): boolean {
  if (allowlist === null) return true;
  if (typeof allowlist === 'function') return allowlist(tool);
  return allowlist.has(tool.name);
}

export interface SubagentRunResult {
  /** PR-4 widened to StopReason — accepts new fine-grained reasons
   *  (`recovery_capped`, `doom_loop`, `compact_failure`). Existing consumers
   *  that switch only on `'completed' | 'error'` keep working. */
  reason: import('@mcp/code-agent/core/runner.js').StopReason;
  finalText: string;
  usage: ChatUsage;
  /** Path strings flagged by the path-scope wrapper, in arrival order. */
  sandboxViolations: string[];
}

export interface SubagentParent {
  provider: ChatProvider;
  /** Snapshot of the parent registry's tools — filtered by `spec.allowlist`. */
  tools: CoderTool[];
  ctx: ToolContext;
  /** Persistent session id of the parent runner — propagated so subagent logs read `s=<parentId>/sub`. */
  sessionId?: number;
  /**
   * Parent's SessionStore — when present, the implement-subagent's system
   * prompt is mirrored into `coder_session_inputs` (kind `subagent_prompt`)
   * for the Input tab in the session details modal.
   */
  sessionStore?: import('@mcp/code-agent/sessions/store.js').SessionStore;
  /**
   * PR-6 (R23): when true, the parent is running with Agent Loop v2 enabled
   * and the subagent inherits the v2 features (pre-read enforcement,
   * result-content dedup, exp+jitter retry). The runner also appends the
   * short subagent-specific framing (persistence + don't re-read) to the
   * provided `systemPrompt`. Default false — subagents keep legacy behaviour
   * if the parent isn't explicitly v2.
   */
  agentLoopV2?: boolean;
}

/**
 * Spin up an isolated CoderRunner constrained by `spec`, run it to completion,
 * and return the structured result.
 *
 * The subagent inherits the parent's provider instance (no extra connection
 * pool needed for sequential subagents), the same overlay/cwd, and the parent
 * abort signal. It does NOT receive a `ctx.runner` back-reference — submit_plan,
 * ask_user and submit_tasks intentionally fail inside subagents because the
 * subagent only talks to its parent via the final `<result>` block, never to
 * the user directly.
 */
export async function runSubagent(parent: SubagentParent, spec: SubagentSpec): Promise<SubagentRunResult> {
  const sandboxViolations: string[] = [];

  // Build the filtered + (optionally) path-wrapped registry. `allowlist`
  // accepts Set / predicate / null (full access) — see SubagentAllowlist.
  const subRegistry = new ToolRegistry();
  for (const tool of parent.tools) {
    if (!isAllowed(spec.allowlist, tool)) continue;
    subRegistry.register(spec.pathScope ? wrapToolForPathScope(tool, spec.pathScope, sandboxViolations) : tool);
  }

  const subContext: ToolContext = {
    cwd: parent.ctx.cwd,
    projectName: parent.ctx.projectName,
    overlay: parent.ctx.overlay,
    signal: parent.ctx.signal,
    // Inherit the parent's "unrestricted tool output" toggle so MCP/code_exec
    // calls inside the subagent honour the same per-call truncation policy
    // as the main session (with the smaller subagent ceiling enforced by
    // the runner's `effectivePushTimeCap`).
    unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput,
    // Intentionally NO `runner` — interactive tools fail inside the subagent.
    planMode: false,
  };

  // PR-6 (R23): when v2 is on, append the subagent-specific framing to the
  // domain-specific system prompt so the subagent inherits the persistence
  // + anti-rerun discipline. The active-context pointer is intentionally
  // omitted because subagents don't receive that injection.
  const v2Framing = parent.agentLoopV2
    ? (await import('@mcp/code-agent/core/system-prompt.js')).buildSubagentLoopFraming()
    : '';
  const finalSystemPrompt = spec.systemPrompt + v2Framing;

  const subRunner = new CoderRunner({
    provider: parent.provider,
    registry: subRegistry,
    systemPrompt: finalSystemPrompt,
    toolContext: subContext,
    initialMessages: spec.initialMessages,
    maxTurns: spec.maxTurns,
    pushTimeCap: spec.pushTimeCap ?? SUBAGENT_TOOL_RESULT_CAP,
    sessionId: parent.sessionId,
    isSubagent: true,
    // PR-6: subagent inherits the parent's v2 flag so pre-read cap, result-
    // dup cap, and exp+jitter retry apply inside the subagent loop too.
    agentLoopV2: parent.agentLoopV2,
    // Inherit the parent's "unrestricted tool output" toggle so the subagent's
    // `effectivePushTimeCap` is bumped to UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP
    // (≈500 KB) instead of the default 12 KB when the parent session has the
    // toggle on. Coherent with the user intent: "this whole session is free."
    unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput ?? false,
  });

  if (parent.ctx.signal) {
    parent.ctx.signal.addEventListener('abort', () => subRunner.abort(), { once: true });
  }

  // Propagate selected sub-runner events to the PARENT so the dashboard's
  // StuckBanner doesn't trip and the user sees progress for what would
  // otherwise be a black-box `spawn_agent` invocation. Mirrors the same
  // pattern `runParallelAgents` uses (tool_call_result → onProgress).
  //   - tool_progress: heartbeat from Camada 1/3/4 of the SUB's BT.
  //   - tool_call_result: per-call activity ping with a [subagent] prefix
  //     so the parent's Worker Log shows what the sub is doing.
  const parentEmit = parent.ctx.runner;
  let subToolCalls = 0;
  if (parentEmit) {
    subRunner.on('tool_progress', (payload) => {
      parentEmit.emit('tool_progress', {
        ...payload,
        note: `[subagent] ${payload.note ?? payload.name}`,
      });
    });
    subRunner.on('tool_call_result', (_id, name) => {
      subToolCalls++;
      parentEmit.emit('tool_progress', {
        id: `subagent-tool:${subRunner.runId}:${subToolCalls}`,
        name: `subagent:${name}`,
        elapsedMs: 0,
        note: `[subagent] ${name} ✓ (#${subToolCalls})`,
      });
    });
  }

  let result: { totalUsage: ChatUsage; reason: SubagentRunResult['reason'] };
  try {
    result = await subRunner.run();
  } catch (e) {
    return {
      reason: 'error',
      finalText: e instanceof Error ? e.message : String(e),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      sandboxViolations,
    };
  }

  return {
    reason: result.reason,
    finalText: extractLastAssistantText(subRunner.messages),
    usage: result.totalUsage,
    sandboxViolations,
  };
}

/**
 * Read-only allowlist for the explore subagent (legacy `spawn_subagent`)
 * and for parallel agents spawned via `spawn_agents`. Includes MCP indexer
 * tools plus native read-only filesystem, web, and diagnostics tools.
 * Explicitly excludes mutating tools (write/edit/shell/git admin).
 */
export const EXPLORE_ALLOWLIST = new Set<string>([
  'mcp__get_project_pulse',
  'mcp__get_project_overview',
  'mcp__get_project_stats',
  'mcp__get_architecture',
  'mcp__list_directory',
  'mcp__list_projects',
  'mcp__get_recently_modified_files',
  'mcp__get_file_skeleton',
  'mcp__get_file_structure',
  'mcp__get_symbol_body',
  'mcp__get_symbol_details',
  'mcp__get_class_members',
  'mcp__get_dependencies',
  'mcp__get_dependents',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__trace_usage',
  'mcp__get_hierarchy',
  'mcp__grep_code',
  'mcp__read_file',
  'mcp__search',
  'mcp__search_by_kind',
  'mcp__search_concepts',
  'mcp__query_snapshots',
  'mcp__get_context_for',
  'mcp__prepare_edit',
  // Native read-only filesystem
  'read_file',
  'list_directory',
  'glob',
  // Web (read-only external fetch)
  'web_fetch',
  'web_search',
  // Read-only diagnostics / LSP / git inspection
  'get_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover',
  'lsp_diagnostics',
  'git_status',
  'git_diff',
  'git_log',
]);

/**
 * Read-only filter — admits every name in `EXPLORE_ALLOWLIST` PLUS every
 * external MCP tool that doesn't mutate. The static allowlist alone misses
 * the user's installed MCP servers (`github_*`, `slack_*`, custom servers
 * registered at runtime); the predicate plugs them in based on the
 * `mutates` / source flags carried on each `CoderTool`.
 */
export const READ_ONLY_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (EXPLORE_ALLOWLIST.has(tool.name)) return true;
  if (tool.source === 'mcp_external') {
    // External MCPs default to `mutates: true` (conservative) when the
    // server didn't declare otherwise; only admit those that explicitly
    // self-declare as non-mutating.
    return tool.mutates === false;
  }
  return false;
};

/**
 * Read-write filter — `IMPLEMENT_ALLOWLIST` PLUS every external MCP tool,
 * mutating or not. The implement subagent is supposed to make changes
 * end-to-end so denying mutating MCPs would defeat the point.
 */
export const READ_WRITE_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (IMPLEMENT_ALLOWLIST.has(tool.name)) return true;
  if (EXPLORE_ALLOWLIST.has(tool.name)) return true; // implement inherits read tools
  if (tool.source === 'mcp_external') return true;
  return false;
};

/**
 * Full-access filter — `null` means "no filter, inherit the parent
 * registry as-is". Use this for an unrestricted subagent that can call
 * every tool the parent has (every tier, every MCP, every native).
 */
export const FULL_ACCESS_FILTER: SubagentAllowlist = null;

/**
 * Verify filter — read tools + shell + LSP diagnostics, NO edit/write.
 * For `kind: 'verify'` tasks in execute_tasks: run tests, linters,
 * type-checkers, observe output, report findings. Cannot mutate code.
 */
export const VERIFY_FILTER: (tool: CoderTool) => boolean = (tool) => {
  if (EXPLORE_ALLOWLIST.has(tool.name)) return true;
  if (tool.name === 'run_command' || tool.name === 'run_command_pty') return true;
  if (tool.name === 'get_diagnostics' || tool.name === 'lsp_diagnostics') return true;
  // MCP external tools that are explicitly non-mutating (test runners, linters
  // exposed via MCP).
  if (tool.source === 'mcp_external' && tool.mutates === false) return true;
  return false;
};

/**
 * Allowlist for an implementation subagent. Includes the read tools needed to
 * navigate the local file scope plus the mutating tools that actually carry
 * out the task. Notably absent: submit_plan, submit_tasks, ask_user,
 * spawn_subagent, execute_task, task_complete — subagents do not interact
 * with the user or recurse into other subagents.
 */
export const IMPLEMENT_ALLOWLIST = new Set<string>([
  // Read tools (essential subset of the explore allowlist)
  'mcp__read_file',
  'mcp__get_file_skeleton',
  'mcp__get_symbol_body',
  'mcp__grep_code',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__list_directory',
  'mcp__get_dependencies',
  // Native filesystem reads (faster than MCP for paths the subagent owns)
  'read_file',
  // Mutating filesystem tools — the whole point of an implement subagent
  'write_file',
  'edit_file',
  'create_file',
  // Shell — gated by the parent runner's plan-mode allowlist for read-only,
  // but inside an approved task scope the subagent gets the full set.
  'run_command',
]);

/**
 * Format a TaskReference into a readable Markdown-style block for the
 * implement subagent's system prompt. Snippets get fenced code blocks; symbol
 * and file refs get a single line. Doc refs are dumped verbatim.
 */
function formatReference(r: TaskReference): string {
  let base: string;
  switch (r.type) {
    case 'symbol':
      base = `**Symbol**: \`${r.value}\``;
      break;
    case 'file':
      base = `**File reference**: \`${r.value}\` (read it via mcp__read_file or get_file_skeleton)`;
      break;
    case 'snippet':
      base = `**Snippet**:\n\n\`\`\`\n${r.value}\n\`\`\``;
      break;
    case 'doc':
      base = `**Doc**:\n${r.value}`;
      break;
    default:
      base = String(r);
  }
  const meta: string[] = [];
  if (r.file) meta.push(`file: \`${r.file}\``);
  if (r.lines) meta.push(`lines: ${r.lines}`);
  if (r.note) meta.push(r.note);
  if (meta.length) base += `\n  _${meta.join(' | ')}_`;
  return base;
}

function buildImplementSystemPrompt(task: CoderTask): string {
  const fileList = task.files.length > 0 ? task.files.map((f) => `- ${f}`).join('\n') : '(none declared)';
  const refs = (task.references && task.references.length > 0)
    ? task.references.map(formatReference).join('\n\n')
    : '(no references — work from the files in scope)';

  return `You are an IMPLEMENTATION subagent. The orchestrator delegated ONE specific task to you. Execute it end-to-end with the tools available, then stop.

# Your task
${task.title}

${task.description}

# Files in scope (you may read AND write these)
${fileList}

# Curated references the orchestrator pre-extracted
${refs}

# Rules
1. Stay inside the files listed above. Reading other files is allowed but logged as a sandbox warning that the orchestrator will see.
2. Make the changes, then VERIFY them when appropriate (run tests/build/lint via run_command).
3. STOP when the task is done. Do not start adjacent work even if you notice opportunities.
4. Your LAST assistant message MUST contain a JSON block in this exact format:
   \`\`\`
   <result>{"summary": "<≤200 chars: what was done>", "files_modified": ["path1", "path2"], "errors": "<only on failure>"}</result>
   \`\`\`
   The orchestrator parses this. If the block is absent or unparseable, the task is treated as failed.
5. You CANNOT call submit_plan, submit_tasks, ask_user, spawn_agent, execute_task, or task_complete. You answer only to the orchestrator via your final <result> block.
6. Be terse. Don't narrate every file read — just do the work and report.

# Token economy
Prefer get_file_skeleton + get_symbol_body over read_file of whole files. Use grep_code/find_references for navigation. Avoid re-reading files you already read this turn.`;
}

/**
 * High-level entry point for executing a single CoderTask in an isolated
 * implementation subagent. Builds the system prompt + initial message, calls
 * runSubagent, and parses the final `<result>` block into a TaskResult.
 */
export async function runImplementSubagent(parent: SubagentParent, task: CoderTask): Promise<TaskResult> {
  const systemPrompt = buildImplementSystemPrompt(task);
  if (parent.sessionStore && parent.sessionId != null) {
    try {
      parent.sessionStore.recordSessionInput({
        session_id: parent.sessionId,
        kind: 'subagent_prompt',
        source_label: `subagent:implement:${task.id}`,
        content: systemPrompt,
        meta: {
          task_id: task.id,
          task_title: task.title,
          files: task.files,
          complexity: task.estimated_complexity,
        },
      });
    } catch {
      // best-effort
    }
  }
  const initialMessages: AgentMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Begin the task now. When done, output your final <result> block as instructed. ` +
            `Reminder: stay inside the files listed in the system prompt.`,
        },
      ],
    },
  ];

  const result = await runSubagent(parent, {
    systemPrompt,
    allowlist: IMPLEMENT_ALLOWLIST,
    initialMessages,
    // Implement subagents need more turns than explore — they read, edit,
    // verify, and report. 40 gives realistic margin for non-trivial tasks.
    // Override via CODER_IMPLEMENT_MAX_TURNS.
    maxTurns: Number(process.env.CODER_IMPLEMENT_MAX_TURNS ?? 40),
    pathScope: task.files,
  });

  const parsed = parseResultBlock(result.finalText);
  if (parsed) {
    return {
      summary: parsed.summary || '(subagent returned an empty summary)',
      files_modified: parsed.files_modified ?? [],
      errors: parsed.errors,
      sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
      subagent_usage: result.usage as unknown as Record<string, number | undefined>,
    };
  }

  // No structured result — surface what we can so the orchestrator gets
  // actionable info instead of a silent "failed".
  return {
    summary: 'subagent did not return a structured <result> block',
    files_modified: [],
    errors: result.finalText
      ? `subagent reason=${result.reason}. Last assistant text: ${result.finalText.slice(0, 400)}`
      : `subagent reason=${result.reason}; produced no text output`,
    sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
    subagent_usage: result.usage as unknown as Record<string, number | undefined>,
  };
}

/**
 * Permissive parser for the subagent's `<result>{...}</result>` JSON block.
 * Tries the strict pattern first, then falls back to JSON-parsing the whole
 * final text in case the model forgot the wrapper.
 */
function parseResultBlock(finalText: string): { summary: string; files_modified?: string[]; errors?: string } | null {
  if (!finalText) return null;
  // Strict: <result>{...}</result>
  const match = finalText.match(/<result>([\s\S]*?)<\/result>/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  // Permissive: try parsing the whole text as JSON.
  try {
    const parsed = JSON.parse(finalText.trim());
    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
      return parsed as { summary: string; files_modified?: string[]; errors?: string };
    }
  } catch {
    /* fall through */
  }
  // Last resort: search for a JSON object that has a "summary" key anywhere.
  const objMatch = finalText.match(/\{[\s\S]*?"summary"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Wrap a tool's handler so any path arguments outside `pathScope` are
 * recorded into `violations` (and the call still proceeds — warning mode).
 *
 * We don't touch the parent's tool object — return a clone with a new handler.
 */
function wrapToolForPathScope(tool: CoderTool, pathScope: string[], violations: string[]): CoderTool {
  const fsOrShellTools = new Set([
    'write_file',
    'edit_file',
    'create_file',
    'read_file',
    'mcp__read_file',
    'run_command',
  ]);
  if (!fsOrShellTools.has(tool.name)) return tool;

  return {
    ...tool,
    handler: async (args, ctx): Promise<ToolResult> => {
      const paths = extractPathsFromToolArgs(tool.name, args);
      for (const p of paths) {
        if (!isPathInsideScope(p, pathScope)) {
          violations.push(`${tool.name}:${p}`);
        }
      }
      return tool.handler(args, ctx);
    },
  };
}

// ─── parallel agents ──────────────────────────────────────────

const PARALLEL_AGENT_MAX = Number(process.env.CODER_PARALLEL_AGENT_MAX ?? 5);

export interface ParallelAgentSpec {
  task: string;
  label: string;
  maxTurns: number;
  /**
   * Per-agent overrides — fall back to the global `systemPrompt` /
   * `allowlist` passed to `runParallelAgents` when omitted. Lets a single
   * parallel batch mix `explore` and `implement` (and even `full`) agents.
   */
  systemPrompt?: string;
  allowlist?: SubagentAllowlist;
  pathScope?: string[];
}

export interface ParallelAgentProgress {
  agentIndex: number;
  label: string;
  event: 'spawned' | 'tool_call' | 'completed' | 'error';
  provider?: string;
  model?: string;
  toolCallCount?: number;
  usage?: ChatUsage;
  summary?: string;
  error?: string;
}

export type ParallelAgentResult = SubagentRunResult & { label: string; toolCallCount: number };

/**
 * Run N subagents in parallel with a concurrency limiter. Each agent gets its
 * own isolated CoderRunner and message history. Progress events are emitted
 * via `onProgress` so the UI can show real-time updates.
 */
export async function runParallelAgents(
  parent: SubagentParent,
  agents: ParallelAgentSpec[],
  systemPrompt: string,
  allowlist: SubagentAllowlist,
  onProgress: (p: ParallelAgentProgress) => void,
  concurrency?: number,
): Promise<{ results: ParallelAgentResult[]; totalUsage: ChatUsage }> {
  const limit = Math.min(agents.length, concurrency ?? PARALLEL_AGENT_MAX);
  const results: ParallelAgentResult[] = new Array(agents.length);

  const tasks = agents.map((spec, agentIndex) => async () => {
    onProgress({ agentIndex, label: spec.label, event: 'spawned' });

    let toolCallCount = 0;

    // Per-agent overrides (fall through to the global args).
    const effectiveAllowlist = spec.allowlist ?? allowlist;
    const effectiveSystemPromptBase = spec.systemPrompt ?? systemPrompt;
    const effectivePathScope = spec.pathScope;
    const violationsForThisAgent: string[] = [];

    // Build isolated registry — accepts Set, predicate, or null (full access).
    const subRegistry = new ToolRegistry();
    for (const tool of parent.tools) {
      if (!isAllowed(effectiveAllowlist, tool)) continue;
      subRegistry.register(
        effectivePathScope
          ? wrapToolForPathScope(tool, effectivePathScope, violationsForThisAgent)
          : tool,
      );
    }

    const subContext: ToolContext = {
      cwd: parent.ctx.cwd,
      projectName: parent.ctx.projectName,
      overlay: parent.ctx.overlay,
      signal: parent.ctx.signal,
      // Inherit the parent's "unrestricted tool output" toggle so MCP /
      // code_exec calls inside parallel agents honour the same per-call
      // truncation policy as the main session.
      unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput,
      planMode: false,
    };

    // PR-6 (R23): same v2 framing append as in runSubagent above.
    const v2Framing = parent.agentLoopV2
      ? (await import('@mcp/code-agent/core/system-prompt.js')).buildSubagentLoopFraming()
      : '';
    const finalSystemPrompt = effectiveSystemPromptBase + v2Framing;

    const subRunner = new CoderRunner({
      provider: parent.provider,
      registry: subRegistry,
      systemPrompt: finalSystemPrompt,
      toolContext: subContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: spec.task }] }],
      maxTurns: spec.maxTurns,
      pushTimeCap: SUBAGENT_TOOL_RESULT_CAP,
      sessionId: parent.sessionId,
      isSubagent: true,
      agentLoopV2: parent.agentLoopV2,
      // Subagent inherits parent's unrestricted-tool-output toggle.
      unrestrictedToolOutput: parent.ctx.unrestrictedToolOutput ?? false,
    });

    // Track tool calls for progress reporting (drives `agent_progress`
    // event on the parent → dashboard updates per-agent badges).
    subRunner.on('tool_call_result', () => {
      toolCallCount++;
      onProgress({ agentIndex, label: spec.label, event: 'tool_call', toolCallCount });
    });

    // Propagate sub heartbeats to the PARENT so the StuckBanner doesn't
    // trip during long sub-runner waits (provider.chat lerdo no sub,
    // long invokes inside the sub, etc.). Resets the parent's
    // `lastEventAt` via tool_progress on the master SSE bus.
    const parentEmit = parent.ctx.runner;
    if (parentEmit) {
      subRunner.on('tool_progress', (payload) => {
        parentEmit.emit('tool_progress', {
          ...payload,
          note: `[parallel ${spec.label}] ${payload.note ?? payload.name}`,
        });
      });
    }

    if (parent.ctx.signal) {
      parent.ctx.signal.addEventListener('abort', () => subRunner.abort(), { once: true });
    }

    try {
      const runResult = await subRunner.run();
      const finalText = extractLastAssistantText(subRunner.messages);
      const agentResult: ParallelAgentResult = {
        reason: runResult.reason,
        finalText,
        usage: runResult.totalUsage,
        sandboxViolations: violationsForThisAgent.slice(),
        label: spec.label,
        toolCallCount,
      };
      onProgress({
        agentIndex,
        label: spec.label,
        event: 'completed',
        toolCallCount,
        usage: runResult.totalUsage,
        summary: finalText.slice(0, 500),
      });
      return agentResult;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const agentResult: ParallelAgentResult = {
        reason: 'error',
        finalText: errMsg,
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        label: spec.label,
        toolCallCount,
      };
      onProgress({ agentIndex, label: spec.label, event: 'error', error: errMsg });
      return agentResult;
    }
  });

  // Heartbeat — keep the parent's StuckBanner alive while subagents are
  // mid-stream. Without this, the master goes silent during any window
  // where every sub is awaiting its provider response (no tool_call_result
  // bubbles up → no agent_progress → no SSE event → StuckBanner trips
  // around 30s). Period chosen well below the 30s threshold.
  const HEARTBEAT_MS = Number(process.env.CODER_PARALLEL_HEARTBEAT_MS ?? '15000') || 15_000;
  const startedAt = Date.now();
  const heartbeatTimer = setInterval(() => {
    // Use `tool_progress` on the PARENT runner — same channel the dashboard
    // already monitors for "still working" feedback during long tools.
    parent.ctx.runner?.emit('tool_progress', {
      id: 'spawn_agent',
      name: 'spawn_agent',
      elapsedMs: Date.now() - startedAt,
      note: `${agents.length} parallel agents still running`,
    });
  }, HEARTBEAT_MS);

  // Run with concurrency limit. Heartbeat cleanup MUST happen even on throw.
  let settled: PromiseSettledResult<ParallelAgentResult>[];
  try {
    settled = await withConcurrencyLimit(tasks, limit);
  } finally {
    clearInterval(heartbeatTimer);
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[i] = s.value;
      totalInput += s.value.usage.input_tokens;
      totalOutput += s.value.usage.output_tokens;
      totalCacheRead += s.value.usage.cache_read_input_tokens ?? 0;
      totalCacheCreation += s.value.usage.cache_creation_input_tokens ?? 0;
    } else {
      // Should not happen — errors are caught inside the task.
      const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      results[i] = {
        reason: 'error',
        finalText: errMsg,
        usage: { input_tokens: 0, output_tokens: 0 },
        sandboxViolations: [],
        label: agents[i].label,
        toolCallCount: 0,
      };
    }
  }

  return {
    results,
    totalUsage: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_input_tokens: totalCacheRead,
      cache_creation_input_tokens: totalCacheCreation,
    },
  };
}

/**
 * Execute async tasks with a concurrency limit. Uses a simple worker-pool
 * pattern — no external dependencies.
 */
async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ─── shared helpers ────────────────────────────────────────────

/**
 * Walk the message history backwards and return the most recent assistant
 * message that contains a non-empty text block. Returns '' if none.
 *
 * Exported because both `spawn_subagent` (legacy) and the new
 * `runImplementSubagent` need to extract the final summary text.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim().length > 0) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}
