/**
 * Tool definition shared by native tools (fs/shell/git) and bridged MCP tools.
 *
 * `parameters` is a JSON Schema object describing the tool input. Each provider
 * adapter knows how to translate this into its vendor-specific tool spec.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Coarse risk classification used by the policy module to decide whether a
 * tool may run in the current context, and (in a future phase) whether it
 * is safe to dispatch in parallel with peers. Default resolution lives in
 * `core/policy.ts`:
 *   1. explicit field on the tool (most specific);
 *   2. built-in classification by name for known native tools;
 *   3. conservative fallback (for MCP-external + unknown tools).
 */
export type ToolRiskLevel = 'read' | 'write' | 'execute' | 'admin';

export interface CoderTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Tool source — used by the UI for rendering and by the registry for filtering. */
  source: 'native' | 'mcp' | 'mcp_external';
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Whether the tool changes any state outside its own response: filesystem
   * writes, shell commands, git mutations, MCP server-side mutations, etc.
   * Mutating tools are gated by plan-mode (must `submit_plan` first) and
   * are never paralelizable. Defaults to `true` for `mcp_external` tools
   * with no explicit value (conservative posture); `false` for native read
   * tools recognised by the built-in classifier.
   */
  mutates?: boolean;
  /**
   * Whether two invocations of this tool (or this tool against another
   * `parallelSafe: true` tool) can be dispatched concurrently without
   * data hazards. Pure reads are typically `true`. Anything that touches
   * the filesystem, shell, or git index is `false`. Defaults to
   * `!mutates` when omitted.
   */
  parallelSafe?: boolean;
  /**
   * Coarse risk bucket used by the dashboard for UI hints and (future) by
   * the policy module for tier-orthogonal gating. `read` < `write` <
   * `execute` < `admin`. Defaults are derived in `core/policy.ts`.
   */
  riskLevel?: ToolRiskLevel;
  /**
   * Tool requires a sandbox runtime to execute safely (e.g., scaffolders
   * that materialize new projects, or shell tools that should never touch
   * the host filesystem). The runner blocks invocation when no sandbox is
   * bound to the session. Defaults to `false`.
   */
  requiresSandbox?: boolean;
  /**
   * Tool's path arguments must be inside the active inline task scope
   * (when one is open). Today only the file-mutating tools opt in; setting
   * this to `true` makes the path-confinement check kick in for any tool
   * that takes file paths.
   */
  scopeAware?: boolean;
  /**
   * Tool pauses the runner waiting for human input (`submit_plan`,
   * `ask_user`, `submit_tasks`, …). Interactive tools are never run in
   * parallel, even if `parallelSafe` is otherwise `true`.
   */
  interactive?: boolean;
  /**
   * Tool legitimately produces different results when called repeatedly
   * with identical args because it polls / awaits external state changes.
   * Examples: `wait_for_compile_clean` (Unity assembly state), `wait_agents`
   * (subordinate terminal status), tail-style log readers. Marking the tool
   * `repeatable: true` exempts it from the per-arg duplicate-call cap (the
   * runner's "Refused: called with these exact arguments N times" guard) —
   * because for these tools, repeated identical calls are the entire use
   * case, not a stuck-loop signal.
   *
   * Defaults to `false`. The dup-call cap remains active for all other
   * tools, including MCP external tools that don't follow the
   * `wait_for_/await_/poll_/tail_/monitor_` naming convention (which the
   * MCP loader auto-flags). Only set this when repeated calls with
   * identical args are an expected workflow, not a regression.
   */
  repeatable?: boolean;
  /**
   * Hard timeout for a single invocation, in milliseconds. When undefined,
   * the runner applies a default from `core/tool-timeouts.ts` based on the
   * tool's name/source classification. Set `Infinity` to opt OUT of the
   * runner-level timeout (used by tools that legitimately manage their own
   * wait, e.g. `wait_for_compile_clean`).
   *
   * On timeout the runner emits a synthetic `tool_call_result` with
   * `isError: true` and aborts a per-call `AbortController` chained off the
   * session signal, so cooperative tools (those passing `ctx.signal` to
   * `fetch`/child processes) can clean up.
   */
  timeoutMs?: number;
}

export interface ToolContext {
  /** Project root path. All filesystem operations must stay inside this. */
  cwd: string;
  /** Project name (used to inject project_name into MCP tool calls). */
  projectName: string;
  /** Session overlay — tracks files touched during this session so reads
   *  bypass the stale MCP index. Optional to keep tests lightweight. */
  overlay?: import('@mcp/code-agent/overlay/session-overlay.js').SessionOverlay;
  /**
   * Side-file store for truncated tool outputs. When present, the runner
   * persists large tool results here so the `get_tool_output` native tool
   * can fetch the full content later. Undefined inside subagents and tests.
   */
  toolOutputStore?: import('@mcp/code-agent/overlay/tool-output-store.js').ToolOutputStore;
  /**
   * Per-session "unrestricted tool output" flag. When true, the per-tool-call
   * truncation caps (`MCP_OUTPUT_HARD_CAP` in mcp-bridge, `MAX_OUTPUT_BYTES` in
   * code_exec, `READ_FILE_HARD_MAX` clamp on read_file) are raised to a high
   * safety ceiling instead of using the production defaults. Auto-compaction
   * still runs, so this is not the same as "no caps at all". Mirrors the
   * `coder_sessions.unrestricted_tool_output` column.
   */
  unrestrictedToolOutput?: boolean;
  /** Optional abort signal for long-running operations. */
  signal?: AbortSignal;
  /**
   * Long-running tools can call this to surface progress to the user mid-run.
   * Emits a `tool_progress` runner event with the supplied note (truncated
   * to ~200 chars). No-op when the runner hasn't wired the callback (tests,
   * subagents). Independent of the runner's periodic heartbeat — use this
   * to convey substantive progress ("fetched 3/10 docs") rather than just
   * "still alive".
   */
  reportProgress?: (note: string) => void;
  /** Back-reference to the runner so interactive tools (submit_plan, ask_user)
   *  can pause execution waiting for user input. Set automatically by CoderRunner. */
  runner?: import('@mcp/code-agent/core/runner.js').CoderRunner;
  /** True when the runner was started in plan mode. */
  planMode?: boolean;
  /**
   * True when the project has at least one completed indexing run
   * (`projects.last_indexed` non-null and `file_count > 0`). Tools that
   * depend on the symbol DB should short-circuit to a regex/tree-sitter
   * fallback when this is false instead of returning empty results.
   */
  projectIndexed?: boolean;
  /**
   * Optional persistence sinks for the submit_plan tool. When wired by
   * runCoder() they delegate to the SessionStore so plans show up in
   * the dashboard's "Plans" tab. Tools (and tests) that don't have a
   * store available simply leave these undefined.
   */
  recordPlan?: (toolUseId: string, planText: string) => void;
  resolvePlan?: (
    toolUseId: string,
    status: 'approved' | 'rejected' | 'aborted',
    feedback?: string,
  ) => void;
  /**
   * Persist a new built-in agent for the current session — used by mode
   * transitions (e.g. plan→build after a plan is approved). When wired by
   * runCoder() it delegates to `SessionStore.setSessionAgent` so the NEXT
   * runner creation picks up the new agent's defaults (planMode, profile,
   * etc.) automatically. The in-memory runner's `opts.agentId` stays put;
   * the transition takes full effect on the next message turn.
   */
  setSessionAgent?: (agent: import('@mcp/code-agent/agents/index.js').AgentId) => void;
  /**
   * Optional persistence sinks for the submit_tasks / execute_task /
   * task_complete tools. Wired by runCoder() so the dashboard's task list
   * UI can read/update state across SSE reconnects and resume after restart.
   * Tests can leave them undefined and the tools degrade to in-memory only.
   */
  recordTasks?: (
    toolUseId: string,
    state: import('@mcp/code-agent/sessions/types.js').TasksState,
  ) => void;
  resolveTasks?: (verdict: {
    approved: boolean;
    tasks?: import('@mcp/code-agent/sessions/types.js').CoderTask[];
    execution_mode?: import('@mcp/code-agent/sessions/types.js').TaskExecutionMode | null;
  }) => void;
  updateTaskStatus?: (
    taskId: string,
    patch: Partial<import('@mcp/code-agent/sessions/types.js').CoderTask>,
  ) => import('@mcp/code-agent/sessions/types.js').TasksState | null;
  getTasksState?: () => import('@mcp/code-agent/sessions/types.js').TasksState | null;
  clearTasksState?: () => boolean;
  /**
   * Optional persistence sinks for the goal tools (`create_goal`,
   * `get_goal`, `update_goal`). Wired by `runCoder` so the goal survives
   * runner restarts and shows the same value across dashboard reloads.
   * Tools that don't have a session-store available (tests, ephemeral
   * subagents) leave these undefined and the goal tool falls back to its
   * in-memory WeakMap.
   */
  getGoalState?: () => {
    text: string;
    status: 'in_progress' | 'complete';
    budgetTokens: number | null;
    completionNote: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  upsertGoalState?: (goal: {
    text: string;
    status: 'in_progress' | 'complete';
    budgetTokens?: number | null;
    completionNote?: string | null;
    createdAt: string;
    updatedAt: string;
  }) => void;
  /** Company orchestrator context — present when this runner is part of a company session. */
  companyContext?: import('@mcp/company/types.js').CompanyContext;
  /**
   * Coder session id (mirrors RunnerOptions.sessionId). Used to key
   * per-agent resources like the dedicated preview/devtools window. Company
   * agents key off `companyContext.agentRunId/companySessionId` instead.
   */
  sessionId?: number;
  /**
   * Optional execution ports — when provided, filesystem/shell tools
   * route through these instead of talking to `node:fs` / `child_process`
   * directly. Left undefined, tools fall back to process-wide local
   * adapters (identical to pre-refactor behavior).
   *
   * Injected by SandboxService when a session runs in builder mode so the
   * same tool code writes into an ephemeral container instead of the host.
   */
  ports?: {
    fs?: import('@mcp/code-agent/ports/filesystem-port.js').IFilesystemPort;
    shell?: import('@mcp/code-agent/ports/shell-port.js').IShellPort;
  };
  /**
   * Frente C (PR 3 da reavaliação) — present only inside subagent runs.
   * The `record_memo` tool consults this; subagent-collector-aware tool
   * wrappers (snapshot, board_post) also mirror their writes here so
   * the parent gets a structured trail.
   *
   * Untyped here to avoid a circular import with `tools/subagent-collector.ts`;
   * the consumer narrows when needed.
   */
  subagentCollector?: import('@mcp/code-agent/tools/subagent-collector.js').SubagentCollector;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Token usage consumed by a sub-runner spawned inside this tool (e.g.
   * spawn_subagent). The parent runner adds these into its `totalUsage` so
   * subagent costs are NEVER hidden — they always show up in the parent
   * session's billing and the dashboard token counters.
   */
  subUsage?: import('@mcp/code-agent/core/messages.js').ChatUsage;
  /**
   * Optional user-message content blocks the runner should append AFTER the
   * tool result. Used by tools like `view_image` that need to inject content
   * (an image, a document) the model can actually perceive on its next turn.
   * The runner emits a synthetic `{ role: 'user', content: extraUserBlocks }`
   * message immediately after the tool batch.
   */
  extraUserBlocks?: import('@mcp/code-agent/core/messages.js').ContentBlock[];
}

export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}
