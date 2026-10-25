export interface ToolContextServices {
  sessionNetwork?: import('../runtime/session-network.js').SessionNetwork;
  ultraBudget?: import('../runtime/ultra-budget.js').UltraAgentBudget;
  ultraPolicy?: import('@mcp/agent-runtime-contracts').PresetResolution;
  /** Session/peer mailbox independent of Company orchestration. */
  collaboration?: {
    actor: string;
    store: import('@mcp/session-storage/collaboration/store.js').ChatCollaborationStore;
  };
  /** Project root path of the PRIMARY project. Native fs operations default here
   *  and must stay inside SOME known root (primary or a linked `roots` entry). */
  cwd: string;
  /**
   * Session project name injected into MCP calls. In ordinary sessions this is
   * the real project; in global sessions it is the primary real project.
   * Use `globalWorkspace` for every linked project/root.
   */
  projectName: string;
  /**
   * Global-session multi-root metadata. `cwd` is the primary real project and
   * every project entry carries its own authorized root. No union directory or
   * symbolic link is created. Undefined for ordinary sessions.
   */
  globalWorkspace?: {
    sessionTitle: string;
    primaryRootPath: string;
    projects: ReadonlyArray<{
      projectId: number;
      name: string;
      slug: string;
      rootPath: string;
      isPrimary: boolean;
    }>;
  };
  /**
   * Linked secondary roots for a global session. Public native-tool paths use
   * `<slug>/...`; the primary remains the unprefixed `cwd`. Each slug also
   * matches the `mcp__<slug>__*` tool prefix. Empty for ordinary sessions.
   */
  roots?: ReadonlyArray<{ projectId: number; name: string; slug: string; rootPath: string }>;
  /** Host directories explicitly authorized for this session. These are kept
   * separate from linked projects: they are not indexed/config roots and are
   * reachable only through native filesystem tools using absolute paths. */
  externalRoots?: ReadonlyArray<{
    id: string;
    /** Numeric ordering key; never used as public identity. */
    seq?: number;
    rootPath: string;
    access: 'read' | 'write';
  }>;
  /** Persist and activate one user-approved external root during a live run. */
  authorizeFilesystemRoot?: (
    rootPath: string,
    access: 'read' | 'write',
  ) => Promise<{ rootPath: string; access: 'read' | 'write' }>;
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
  /**
   * Session-owned large-output store. Implementations may keep a synchronous
   * hot cache for tool execution, but `drain()` is the durability barrier the
   * host awaits before committing the containing turn.
   */
  toolOutputStore?: {
    put(content: string): string | null;
    putImage?(image: { name?: string; mediaType: string; base64: string }): string | null;
    listImages?(): Array<{ id: string; name: string; mediaType: string }>;
    get(id: string, signal?: AbortSignal): string | null | Promise<string | null>;
    hasOutputs(): boolean;
    drain?(): Promise<void>;
  };
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
   * defaults). Auto-compaction still runs. Mirrors the bundle state projection.
   */
  toolOutputCapLevel?: import('./runner/output-caps.js').ToolOutputCapLevel;
  /**
   * Per-session tool permission gate (ask/auto/unrestricted). Consulted by
   * executing-dispatch and code_exec BEFORE invoking gated tools. Holds the
   * PARENT runner's waitForUserInput/emit, so subagent context copies surface
   * and resolve approvals at session level. Mirrors `state.json`.
   * Undefined in ephemeral tests.
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
    getDiffs(): Promise<import('@mcp/services/services/session-snapshots.js').FileDiff<string>[]>;
    /** Pre-edit content of one baseline. Null when the file did not exist OR
     *  the content is unavailable (oversized/binary baseline) — never ''. */
    getBeforeContent(baselineId: string): Promise<string | null>;
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
  /** Optional artifact notification for injected tool contexts. Files are
   * already persisted; this notification must not perform another write. */
  onDiagramChanged?: (payload: { path: string; xml: string }) => void;
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
   * runCoder() they delegate to the filesystem session repository so plans show up in
   * the dashboard's "Plans" tab. Tools (and tests) that don't have a
   * store available simply leave these undefined.
   */
  recordPlan?: (toolUseId: string, planText: string) => void | Promise<void>;
  resolvePlan?: (
    toolUseId: string,
    status: 'approved' | 'rejected' | 'aborted',
    feedback?: string,
  ) => void | Promise<void>;
  /**
   * Persist a new built-in agent for the current session — used by mode
   * transitions (e.g. plan→build after a plan is approved). When wired by
   * runCoder() it delegates to `SessionStore.setSessionAgent` so the NEXT
   * runner creation picks up the new agent's defaults (planMode, profile,
   * etc.) automatically. The in-memory runner's `opts.agentId` stays put;
   * the transition takes full effect on the next message turn.
   */
  setSessionAgent?: (
    agent: import('@mcp/code-agent/agents/index.js').AgentId,
  ) => void | Promise<void>;
  /**
   * Optional persistence sinks for the submit_tasks / execute_task /
   * task_complete tools. Wired by runCoder() so the dashboard's task list
   * UI can read/update state across SSE reconnects and resume after restart.
   * Tests can leave them undefined and the tools degrade to in-memory only.
   */
  recordTasks?: (
    toolUseId: string,
    state: import('@mcp/session-storage/session-state-types.js').TasksState,
  ) => void | Promise<void>;
  resolveTasks?: (verdict: {
    approved: boolean;
    tasks?: import('@mcp/session-storage/session-state-types.js').CoderTask[];
    execution_mode?: import('@mcp/session-storage/session-state-types.js').TaskExecutionMode | null;
  }) => void | Promise<void>;
  updateTaskStatus?: (
    taskId: string,
    patch: Partial<import('@mcp/session-storage/session-state-types.js').CoderTask>,
  ) =>
    | import('@mcp/session-storage/session-state-types.js').TasksState
    | null
    | Promise<import('@mcp/session-storage/session-state-types.js').TasksState | null>;
  getTasksState?: () =>
    | import('@mcp/session-storage/session-state-types.js').TasksState
    | null;
  /** Task-run display projection; the task board/journal remains authoritative. */
  completeInlineTaskRun?: (task: import('@mcp/session-storage/session-state-types.js').CoderTask) => Promise<{
    run_id: string; status: 'completed' | 'failed'; total_usage: import('./messages.js').ChatUsage; finished_at: string;
  } | null>;
  clearTasksState?: () => boolean | Promise<boolean>;
  /**
   * Declares that a SUCCESSFUL goal tool call intentionally changed no state
   * (redundant create against an in_progress goal, update to the status the
   * goal already has). Without it the persistence invariant — every successful
   * goal tool must carry a staged mutation — treats the idempotent success as
   * a lost write and fails the whole turn.
   */
  noteGoalUnchanged?: (attribution: {
    toolUseId: string;
    toolName: 'create_goal' | 'update_goal';
  }) => void;
  /**
   * Runtime-owned objective authority. `update_goal(status="superseded")`
   * is accepted only for an explicit user pivot classified required_pivot.
   */
  goalLifecycleIntent?:
    | 'required_fresh'
    | 'required_pivot'
    | 'required_resume'
    | 'ledger';
  /**
   * Exact inherited goal generation that an explicit pivot may supersede.
   * Kept separate from required_fresh so a goal created during this run can
   * never inherit authority intended for the previous objective.
   */
  goalLifecyclePivotGoalCreatedAt?: string;
  /**
   * Session Drive sinks — the session's durable working memory (migrations
   * 125/126). Wired by `runCoder` for non-company sessions so the
   * `read_plan` / `remember` / `list_memory` / `recall_investigations`
   * tools persist + read through the SessionStore. Undefined inside company
   * sessions, ephemeral subagents, and tests (the tools then return a clear
   * "not available here" message instead of throwing).
   */
  sessionDrive?: {
    assertCurrent?(): void;
    readActivePlan(signal?: AbortSignal): Promise<{ text: string; status: string } | null>;
    remember(input: {
      title: string;
      body: string;
      kind?: string;
      pinned?: boolean;
      operation_id?: string;
    }, beforePublish?: () => void): Promise<{ title: string }>;
    listMemory(opts?: { kind?: string; limit?: number; offset?: number; signal?: AbortSignal }): Promise<
      Array<{
        kind: string;
        title: string;
        body: string;
        pinned: boolean;
        updated_at: string;
      }>
    >;
    recallInvestigations(query: string, limit?: number, signal?: AbortSignal): Promise<Array<{ topic: string; summary: string; source_label: string | null; agent_type: string | null; created_at: string }>>;
  };
  /**
   * Append-only conversation history created by automatic/manual compaction.
   * The small chapter index is injected proactively; this port backs the
   * explicit `recall_conversation` drill-down without putting the complete
   * historical summaries (or raw transcript) into every prompt.
   */
  conversationHistory?: {
    assertCurrent?(): void;
    list(opts?: { limit?: number; cursor?: string | null }): Promise<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterPage<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterRow>>;
    search(query: string, opts?: { limit?: number; cursor?: string | null }): Promise<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterPage<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterSearchResult>>;
    get(chapterId: string): Promise<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterRow | null>;
    source(chapterId: string, opts?: { limit?: number; cursor?: string | null }): Promise<import('@mcp/session-storage/fs-store/history-metrics-types.js').FsConversationChapterSourcePage>;
  };
  /**
   * Durable PROJECT memory ports (cross-session, snapshots table). Wired by
   * `runCoder` from the host's `RunCoderOptions.projectMemory` callback when
   * the project has memory enabled. `save` rides the same dedup/merge as the
   * distillers; `recall` is the semantic full-content fetch behind the
   * `recall_memory` tool. Undefined → tools answer with a clear message
   * instead of throwing (company sessions, subagents, tests).
   */
  agentReads?: import('@mcp/code-agent/ports/agent-read-port.js').AgentReadPort;
  projectMemory?: {
    save(entry: {
      title: string;
      content: string;
      category: string;
    }): Promise<{ created: number; merged: number; skipped: number } | null>;
    recall(query: string, limit?: number, signal?: AbortSignal): Promise<Array<{
      id: string;
      title: string;
      content: string;
      category?: string;
      source?: string;
      importance?: number;
      staleNote?: string;
    }>>;
    /** Project memory index (frontmatter) for `recall_memory(mode:'list')`. */
    list?(limit?: number, type?: string, signal?: AbortSignal): Promise<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>;
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
  sessionId?: import('@mcp/session-storage').SessionId;
  /**
   * Opaque identity of the current root AgentRun, established by the host
   * before worker dispatch. Subagent creation uses it as the authoritative
   * parent link instead of racing the asynchronous runner_run_id mirror.
   * It is metadata only: no actor, lease owner, or fence crosses the worker
   * boundary through this field.
   */
  controlPlaneParentAgentRunId?: string;
  /**
   * The session bundle's owning project id. Lets project-aware
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
  /** Host-owned synchronous check at the external MCP wire dispatch, after reconnect. */
  assertExternalMcpDispatch?: () => void;
  /** Opaque product authority carried by the worker; only the owning host validates it. */
  externalMcpAuthority?: { payload: unknown; outcomeUnknown(): void };
  /** Original normalized invocation, sealed by the resource binding. */
  currentToolInvocation?: { name: string; input: Record<string, unknown> };
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
    projectIndex?: import('@mcp/code-agent/ports/project-index-port.js').ProjectIndexPort;
    documentExport?: import('@mcp/code-agent/ports/document-export-port.js').DocumentExportPort;
    memoryMutations?: import('@mcp/code-agent/ports/memory-mutation-port.js').MemoryMutationPort;
    fs?: import('@mcp/code-agent/ports/filesystem-port.js').IFilesystemPort;
    shell?: import('@mcp/code-agent/ports/shell-port.js').IShellPort;
    commands?: import('@mcp/code-agent/ports/persistent-command-port.js').IPersistentCommandPort;
    interactions?: import('@mcp/code-agent/ports/interactive-tool-port.js').InteractiveToolPort;
    database?: import('@mcp/code-agent/ports/database-port.js').DatabasePort;
    http?: import('@mcp/code-agent/ports/http-port.js').HttpPort;
    web?: import('@mcp/code-agent/ports/web-port.js').WebPort;
    lsp?: import('@mcp/code-agent/ports/lsp-port.js').AgentLspPort;
    apiClient?: { readonly projectId: number; readonly http: import('@mcp/code-agent/ports/http-port.js').HttpPort; assertCurrent(): void };
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
