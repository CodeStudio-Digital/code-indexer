/**
 * `JsonSchema` (the tool-input schema) now lives in `@mcp/provider-sdk` so the
 * provider adapter contract can reference it without depending back into
 * code-agent. Re-exported here so existing importers keep working.
 */
export type { JsonSchema } from '@mcp/provider-sdk';

import type { JsonSchema } from '@mcp/provider-sdk';

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
export type ToolRepeatPolicy = 'stable' | 'volatile' | 'pollable' | 'mutating';
export type ToolExecutionClass = 'read' | 'write' | 'execute' | 'control';

/**
 * Runtime-only progressive-disclosure metadata for tools contributed by a
 * dynamic provider (for example an installed plugin). The runner aggregates
 * these declarations into its tier map and `expand_toolset` catalog; this
 * metadata is never serialized into the provider-facing tool definition.
 */
export interface RuntimeToolTierMetadata {
  id: string;
  displayName: string;
}

/** Structured outcome from an invocation/no-progress guard. */
export type GuardAction = 'allow' | 'reuse' | 'warn' | 'block' | 'shadow';

export interface GuardVerdict {
  action: GuardAction;
  /** Stable, machine-readable reason (for example `mutating-repeat`). */
  reason: string;
  /** Refusal classification when the verdict prevented an invocation. */
  refusalKind?: string;
  /** Whether the runner should route through an explicit reflection turn. */
  shouldReflect: boolean;
  /** Whether this outcome contributes to the ordinary tool failure streak. */
  affectsFailureStreak: boolean;
  /** Number of equivalent attempts observed in the current guard scope. */
  count?: number;
  /** Tool whose invocation produced this verdict. */
  sourceTool?: string;
  /** Tool-use id that caused or originally produced the verdict. */
  originToolUseId?: string;
  /** Observe mode: the action that enforcement would have taken. */
  wouldBlock?: boolean;
  /** Workspace/state version used when the guard made its decision. */
  stateEpoch?: number;
}

export interface CoderTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Tool source — used by the UI for rendering and by the registry for filtering. */
  source: 'native' | 'mcp' | 'mcp_external';
  /** Optional opt-in tier declared by a dynamic tool contributor. */
  runtimeTier?: RuntimeToolTierMetadata;
  /**
   * Model-facing output contract. The runner uses this to choose semantic
   * reduction, inline budget and recovery behaviour instead of applying one
   * blind head/tail cap to every tool family.
   *
   * Dynamic/plugin tools should declare this alongside `runtimeTier`. When it
   * is omitted the runner falls back to conservative name/content inference.
   */
  outputPolicy?: ToolOutputPolicy;
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
   * Dynamic risk classifier consulted by the permission gate BEFORE the
   * static metadata chain, so one tool can be read-risk for some inputs and
   * write-risk for others (e.g. `db_query`: SELECT → 'read', INSERT →
   * 'write'). Must be PURE and non-throwing over arbitrary input; the gate
   * treats a throw as 'write' (fail-safe). When absent, classification falls
   * back to the static chain exactly as before.
   */
  riskOf?(input: unknown): ToolRiskLevel;
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
   * `repeatable: true` is the legacy spelling for `repeatPolicy: 'pollable'`.
   * Pollable tools may repeat identical calls, so polling-stuck (not tuple
   * dedup) owns unchanged-result intervention. This does not imply an infinite
   * timeout; declare `timeoutMs: Infinity` explicitly when required.
   *
   * Defaults to `false`. The dup-call cap remains active for all other
   * tools, including MCP external tools that don't follow the
   * `wait_for_/await_/poll_/tail_/monitor_` naming convention (which the
   * MCP loader auto-flags). Only set this when repeated calls with
   * identical args are an expected workflow, not a regression.
   */
  repeatable?: boolean;
  /**
   * Repetition semantics. `volatile` means results may change but invocation
   * timeout remains active; only `pollable` opts into unbounded waiting.
   */
  repeatPolicy?: ToolRepeatPolicy;
  /**
   * Promote the cross-turn unchanged-result detector from telemetry-only to
   * an active loop break for this tool. Use sparingly for control-plane
   * snapshots whose repeated identical result cannot advance the task. The
   * third unchanged call is still delivered, then the runner forces a
   * planning turn so the model must choose a different action.
   */
  stopOnRepeatedUnchangedResult?: boolean;
  /** Scheduling class used by nested and future parallel dispatchers. */
  executionClass?: ToolExecutionClass;
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
  /**
   * Optional per-invocation timeout resolver. Use this when the handler accepts
   * a bounded timeout argument (for example `run_command.timeout_ms`) so queue
   * acquisition and the runner backstop share the same deadline. Invalid or
   * throwing resolvers fall back to `timeoutMs` / the normal timeout policy.
   */
  resolveTimeoutMs?: (args: Record<string, unknown>) => number;
}

/** One nested tool invocation outcome, reported by code_exec's proxy. */
export interface NestedToolCallRecord {
  /** tool_use id of the parent code_exec block. */
  parentToolUseId: string;
  /** 1-based completion-order sequence within the parent call. */
  seq: number;
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
  resultChars: number;
  /** First ~2k chars of the result/error — telemetry preview, not transcript. */
  resultPreview: string;
  /** Explicit omission metadata from the nested tool producer. */
  sourceTruncations?: ToolSourceTruncation[];
  /** Guard refusal tag when the observer blocked the call (dedup/failure-streak). */
  refusalKind?: string;
  logicalOperationId?: string;
  productive?: boolean;
  resultNovel?: boolean;
  coverageNovel?: boolean;
  /** Resolved repeatPolicy is pollable/volatile. */
  repeatable?: boolean;
  /** False for policy/dedup refusals that should be audited but not count as a tool failure. */
  affectsFailureStreak?: boolean;
  /** Structured invocation/no-progress verdict for direct/nested parity. */
  guardVerdict?: GuardVerdict;
  /** Whether this result was actually delivered back to the script/model. */
  delivered?: boolean;
  /** State version observed by the nested invocation. */
  stateEpoch?: number;
  repeatPolicy?: ToolRepeatPolicy;
  executionClass?: ToolExecutionClass;
}

/**
 * Loop-guard + telemetry hooks for tool calls made INSIDE another tool
 * (code_exec scripts). Implemented over the run's own guard state by
 * runner/guards/nested-observer.ts; consumed by code-exec.ts around each
 * nested `registry.invoke`. Both methods are non-throwing by contract.
 */
export interface NestedToolObserver {
  /**
   * Consult the guards BEFORE a nested call. Non-null = refuse: the caller
   * surfaces `refusalText` as a (catchable) JS exception inside the script.
   */
  beforeNestedCall(
    name: string,
    args: Record<string, unknown>,
    opts?: {
      repeatable?: boolean;
      repeatPolicy?: ToolRepeatPolicy;
      executionClass?: ToolExecutionClass;
      stateEpoch?: number;
      forceReread?: boolean;
      /** Parent-scoped physical attempt id supplied by code_exec. */
      originToolUseId?: string;
    },
  ): (GuardVerdict & {
    /** Human-facing detail for a blocking verdict. */
    refusalText?: string;
    /** Compatibility alias used by refusal/error classification. */
    kind?: 'dedup' | 'failure-streak' | 'allow-with-reminder' | 'shadow';
  }) | null;
  /** Feed guard state + telemetry AFTER a nested call settles. Never throws. */
  afterNestedCall(e: Omit<NestedToolCallRecord, 'parentToolUseId' | 'seq'>): void;
}

export interface ToolContext {
  /** Project root path of the PRIMARY project. Native fs operations default here
   *  and must stay inside SOME known root (primary or a linked `roots` entry). */
  cwd: string;
  /**
   * Session project name injected into MCP calls. In ordinary sessions this is
   * the real project; in global sessions it is the synthetic union project.
   * Use `globalWorkspace` for the real linked projects/folders.
   */
  projectName: string;
  /**
   * Global-session virtual union metadata. The filesystem root (`cwd`) is a
   * directory containing one link per real project, addressed by `slug`.
   * Undefined for ordinary sessions.
   */
  globalWorkspace?: {
    syntheticProjectName: string;
    rootPath: string;
    projects: ReadonlyArray<{
      projectId: number;
      name: string;
      slug: string;
      rootPath: string;
      isPrimary: boolean;
    }>;
  };
  /**
   * Linked SECONDARY roots for a GLOBAL (multi-project) session (migration 152).
   * The PRIMARY stays `cwd`/`projectName`/`projectId`; these are additional roots
   * the agent can read/write by passing `project: "<slug>"` (or `project_name`)
   * to the native fs tools. Each `slug` matches the `mcp__<slug>__*` read-tool
   * prefix the model already sees for that project. Empty/undefined for normal
   * sessions, so single-root behaviour (and the cross-project refusal guard) is
   * unchanged for them.
   */
  roots?: ReadonlyArray<{ projectId: number; name: string; slug: string; rootPath: string }>;
  /**
   * Per-secondary-root session overlays keyed by projectId. `overlay` (below)
   * stays the PRIMARY's overlay; a write to a secondary root marks the touched
   * file in that root's overlay so the project's MCP reads serve fresh content.
   * Undefined for normal sessions.
   */
  overlayByRoot?: ReadonlyMap<number, import('@mcp/code-agent/overlay/session-overlay.js').SessionOverlay>;
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
   * Exact inline ceiling resolved by the active runner/model. Pagination tools
   * use it BEFORE slicing so their page is not truncated a second time by the
   * finalizer. Undefined in lightweight tests and standalone tool hosts.
   */
  toolOutputInlineCap?: number;
  /** Shared direct+nested accounting; it does not enforce budgets. */
  toolCallLedger?: import('./tool-call-ledger.js').ToolCallLedger;
  /**
   * Per-session tool-output cap LEVEL (economic|medium|high|extra|max|ultra).
   * Replaces the legacy binary `unrestrictedToolOutput`. Each cap site calls
   * `capFor(level, <its base>, <its ceiling>)` (`MCP_OUTPUT_HARD_CAP` in
   * mcp-bridge, `MAX_OUTPUT_BYTES` in code_exec, `READ_FILE_HARD_MAX` clamp on
   * read_file, and the runner push-time cap). Undefined → 'economic' (production
   * defaults). Auto-compaction still runs. Mirrors the
   * `coder_sessions.tool_output_cap_level` column.
   */
  toolOutputCapLevel?: import('./runner/output-caps.js').ToolOutputCapLevel;
  /**
   * Per-session tool permission gate (ask/auto/unrestricted). Consulted by
   * executing-dispatch and code_exec BEFORE invoking gated tools. Holds the
   * PARENT runner's waitForUserInput/emit, so subagent context copies surface
   * and resolve approvals at session level. Mirrors
   * `coder_sessions.tool_permission_mode`. Undefined in tests/legacy paths.
   */
  permissionGate?: import('./permission-gate.js').PermissionGate;
  /**
   * tool_use id of the currently executing tool call. Set per-call by the
   * dispatch spread so nested contexts (code_exec) can anchor approval
   * requests to the chat-visible block.
   */
  currentToolUseId?: string;
  /**
   * Chat-visible anchor block for approvals raised in non-visible contexts
   * (subagent runs). Set by runSubagent to the spawning tool_use id.
   */
  approvalAnchorId?: string;
  /**
   * tool_use id of the PARENT call when this context is a nested one
   * (code_exec proxy). Set per-call by the dispatch spread; links nested
   * telemetry rows back to the visible block.
   */
  parentToolUseId?: string;
  /**
   * Loop-guard + telemetry observer for nested tool calls (code_exec).
   * Built per parent call by the Executing node over the run's own guard
   * state; absent in tests/subagent paths and when
   * `CODER_NESTED_GUARDS_DISABLE=1`. See runner/guards/nested-observer.ts.
   */
  nestedToolObserver?: NestedToolObserver;
  /**
   * Session-persistent key-value store exposed to code_exec scripts as the
   * `stash` global. Survives across code_exec calls (the node:vm sandbox
   * does not), so scripts carry file content/intermediate results forward
   * instead of echoing them into history or re-reading files. One instance
   * per session (index.ts); absent in tests → code_exec falls back to an
   * ephemeral per-call store. See tools/code-exec-stash.ts.
   */
  codeExecStash?: import('@mcp/code-agent/tools/code-exec-stash.js').CodeExecStash;
  /**
   * Read-only access to THIS session's pending snapshot diffs, backing the
   * `change` API inside code_exec (tools/code-exec-change.ts) — the
   * "interrogable diff": scripts query the change (files, hunks, before/after
   * symbol bodies, absences) instead of receiving diff text. Wired by
   * runCoder(); absent in tests/subagent-less paths → no `change` global.
   */
  sessionChanges?: {
    /** Reviewable pending diffs (filtered, cumulative baselines). */
    getDiffs(): Promise<import('@mcp/services/services/session-snapshots.js').FileDiff[]>;
    /** Pre-edit content of one baseline. Null when the file did not exist OR
     *  the content is unavailable (oversized/binary baseline) — never ''. */
    getBeforeContent(baselineId: number): Promise<string | null>;
  };
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
  /**
   * Refresh transport/UI liveness without claiming semantic progress. Unlike
   * `reportProgress`, this must not reset the operation's no-real-output age.
   */
  reportHeartbeat?: (note?: string) => void;
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
  /**
   * Session Drive sinks — the session's durable working memory (migrations
   * 125/126). Wired by `runCoder` for non-company sessions so the
   * `read_plan` / `remember` / `list_memory` / `recall_investigations`
   * tools persist + read through the SessionStore. Undefined inside company
   * sessions, ephemeral subagents, and tests (the tools then return a clear
   * "not available here" message instead of throwing).
   */
  sessionDrive?: {
    readActivePlan(): { text: string; status: string } | null;
    remember(input: { title: string; body: string; kind?: string; pinned?: boolean }): { title: string };
    listMemory(opts?: { kind?: string }): Array<{ kind: string; title: string; body: string; pinned: number; updated_at: string }>;
    recallInvestigations(query: string, limit?: number): Promise<Array<{ topic: string; summary: string; source_label: string | null; agent_type: string | null; created_at: string }>>;
  };
  /**
   * Append-only conversation history created by automatic/manual compaction.
   * The small chapter index is injected proactively; this port backs the
   * explicit `recall_conversation` drill-down without putting the complete
   * historical summaries (or raw transcript) into every prompt.
   */
  conversationHistory?: {
    list(opts?: { limit?: number; cursor?: string | null }): import('@mcp/code-agent/sessions/types.js').ConversationChapterPage<import('@mcp/code-agent/sessions/types.js').ConversationChapterRow>;
    search(query: string, opts?: { limit?: number; cursor?: string | null }): import('@mcp/code-agent/sessions/types.js').ConversationChapterPage<import('@mcp/code-agent/sessions/types.js').ConversationChapterSearchResult>;
    get(chapterId: number): import('@mcp/code-agent/sessions/types.js').ConversationChapterRow | null;
    source(chapterId: number, opts?: { limit?: number; cursor?: string | null }): import('@mcp/code-agent/sessions/types.js').ConversationChapterPage<import('@mcp/code-agent/sessions/types.js').CoderMessageRow>;
  };
  /**
   * Durable PROJECT memory ports (cross-session, snapshots table). Wired by
   * `runCoder` from the host's `RunCoderOptions.projectMemory` callback when
   * the project has memory enabled. `save` rides the same dedup/merge as the
   * distillers; `recall` is the semantic full-content fetch behind the
   * `recall_memory` tool. Undefined → tools answer with a clear message
   * instead of throwing (company sessions, subagents, tests).
   */
  projectMemory?: {
    save(entry: {
      title: string;
      content: string;
      category: string;
    }): Promise<{ created: number; merged: number; skipped: number } | null>;
    recall(query: string, limit?: number): Promise<Array<{
      id: string;
      title: string;
      content: string;
      category?: string;
      source?: string;
      importance?: number;
      staleNote?: string;
    }>>;
    /** Project memory index (frontmatter) for `recall_memory(mode:'list')`. */
    list?(limit?: number, type?: string): Promise<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>;
    /** Archive a project memory by name/title (logical delete). Backs `forget_memory`. */
    forget?(target: string): Promise<{ archived: number }>;
  };
  /**
   * Global USER memory port (migration 145) — durable facts about who the user
   * is and how they want the agent to work, stored on the reserved user
   * project and injected into EVERY project. Backs `save_note` scope 'user'.
   * Same dedup/merge as project memory; undefined → the tool answers with a
   * clear message instead of throwing.
   */
  userMemory?: {
    save(entry: {
      title: string;
      content: string;
      category: string;
    }): Promise<{ created: number; merged: number; skipped: number } | null>;
    /** Archive a user-scope memory by name/title (logical delete). */
    forget?(target: string): Promise<{ archived: number }>;
  };
  /** Company orchestrator context — present when this runner is part of a company session. */
  companyContext?: import('@mcp/company/types.js').CompanyContext;
  /**
   * Coder session id (mirrors RunnerOptions.sessionId). Used to key
   * per-agent resources like the dedicated preview/devtools window. Company
   * agents key off `companyContext.agentRunId/companySessionId` instead.
   */
  sessionId?: number;
  /**
   * The session's project id (coder_sessions.project_id). Lets project-aware
   * tools (`rag_search_docs` linked-collection scoping, the `<indexed-docs>`
   * hint) resolve project-scoped state without a DB round-trip per call.
   */
  projectId?: number;
  /**
   * Per-project runtime PATH/env (PHP/Python bin dirs + PHPRC) for shell tools
   * to inject when spawning, so `php`/`composer`/`python`/`pip` resolve to the
   * project's chosen runtime. Resolved once per run by the host (the agent
   * can't import the resolver without a dep cycle). Node is deliberately
   * excluded. Undefined → shell tools inherit the plain (system) env.
   */
  runtimeEnv?: import('@mcp/code-agent/ports/shell-port.js').AgentRuntimeEnv;
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

/** Stable, machine-readable details for an unsuccessful tool result. */
export type ToolErrorKind =
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'permission'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'refusal'
  | 'tool_error'
  | 'internal';

export interface ToolErrorInfo {
  /** Stable code suitable for branching; unlike `content`, it is not prose. */
  code: string;
  kind: ToolErrorKind;
  /** Whether retrying the same operation without changing its inputs may help. */
  retryable: boolean;
  /** Concise recovery direction for programmatic consumers such as code_exec. */
  suggestedAction?: string;
}

/** What kind of information a tool returns to the model. */
export type ToolOutputMode =
  | 'generic'
  | 'authoritative'
  | 'page'
  | 'line_range'
  | 'rows'
  | 'logs'
  | 'diff'
  | 'search'
  | 'structured';

/** How content omitted from the inline representation can be recovered. */
export type ToolOutputRecovery =
  | 'output_store'
  | 'cursor'
  | 'section'
  | 'rerun'
  | 'none';

export interface ToolOutputPolicy {
  mode: ToolOutputMode;
  /** Skip semantic reducers for already-shaped/authoritative payloads. */
  reducer?: 'smart' | 'none';
  /** Preferred recovery contract when the full value does not fit inline. */
  recovery?: ToolOutputRecovery;
  /** Optional per-tool target. It is always clamped by context safety. */
  maxInlineChars?: number;
  /** Preserve full error evidence in the output store even when it fits. */
  preserveOnError?: boolean;
}

/**
 * Machine-readable evidence that a producer intentionally omitted source
 * data before the central reducer saw it. Text markers remain model-facing
 * guidance only and must never be parsed as telemetry truth.
 */
export interface ToolSourceTruncation {
  technique: string;
  inputSize: number;
  /**
   * Whether `inputSize` is the exact pre-cap size. False means it is a
   * truthful lower bound (for example a transfer cancelled as soon as one
   * socket chunk crossed the acquisition ceiling). Defaults to true for
   * older producers that only emit exact materialized sizes.
   */
  inputSizeExact?: boolean;
  outputSize: number;
  unit: 'chars' | 'bytes' | 'lines' | 'rows' | 'items';
  recoverable: boolean;
  /** Exact snapshot id, only when it represents the complete source value. */
  outputId?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Optional structured failure metadata. `content` remains the display text. */
  error?: ToolErrorInfo;
  /** Model-facing representation. Providers receive only `content`. */
  contentFormat?: 'text' | 'markdown' | 'json';
  /**
   * Optional canonical payload retained for internal consumers such as
   * `code_exec` and size telemetry. It is never appended to model history.
   */
  structuredData?: unknown;
  /** Explicit producer-side cuts, carried separately from display text. */
  sourceTruncations?: ToolSourceTruncation[];
  /** Structured guard metadata, including observe-mode would-block signals. */
  guardVerdict?: GuardVerdict;
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

export function err(content: string, error?: ToolErrorInfo): ToolResult {
  return { content, isError: true, ...(error ? { error } : {}) };
}
