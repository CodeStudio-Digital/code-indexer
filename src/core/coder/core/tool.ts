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

export interface CoderTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Tool source — used by the UI for rendering and by the registry for filtering. */
  source: 'native' | 'mcp' | 'mcp_external';
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  /** Project root path. All filesystem operations must stay inside this. */
  cwd: string;
  /** Project name (used to inject project_name into MCP tool calls). */
  projectName: string;
  /** Session overlay — tracks files touched during this session so reads
   *  bypass the stale MCP index. Optional to keep tests lightweight. */
  overlay?: import('../overlay/session-overlay.js').SessionOverlay;
  /**
   * Side-file store for truncated tool outputs. When present, the runner
   * persists large tool results here so the `get_tool_output` native tool
   * can fetch the full content later. Undefined inside subagents and tests.
   */
  toolOutputStore?: import('../overlay/tool-output-store.js').ToolOutputStore;
  /** Optional abort signal for long-running operations. */
  signal?: AbortSignal;
  /** Back-reference to the runner so interactive tools (submit_plan, ask_user)
   *  can pause execution waiting for user input. Set automatically by CoderRunner. */
  runner?: import('./runner.js').CoderRunner;
  /** True when the runner was started in plan mode. */
  planMode?: boolean;
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
   * Optional persistence sinks for the submit_tasks / execute_task /
   * task_complete tools. Wired by runCoder() so the dashboard's task list
   * UI can read/update state across SSE reconnects and resume after restart.
   * Tests can leave them undefined and the tools degrade to in-memory only.
   */
  recordTasks?: (
    toolUseId: string,
    state: import('../sessions/types.js').TasksState,
  ) => void;
  resolveTasks?: (verdict: {
    approved: boolean;
    tasks?: import('../sessions/types.js').CoderTask[];
    execution_mode?: import('../sessions/types.js').TaskExecutionMode | null;
  }) => void;
  updateTaskStatus?: (
    taskId: string,
    patch: Partial<import('../sessions/types.js').CoderTask>,
  ) => void;
  getTasksState?: () => import('../sessions/types.js').TasksState | null;
  /** Company orchestrator context — present when this runner is part of a company session. */
  companyContext?: import('../company/types.js').CompanyContext;
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
    fs?: import('../ports/filesystem-port.js').IFilesystemPort;
    shell?: import('../ports/shell-port.js').IShellPort;
  };
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
  subUsage?: import('./messages.js').ChatUsage;
}

export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}
