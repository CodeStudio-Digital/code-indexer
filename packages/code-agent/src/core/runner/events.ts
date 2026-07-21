import type {
  AgentMessage,
  ChatUsage,
  PlanBlock,
  SpecBlock,
  QuestionBlock,
} from '@mcp/code-agent/core/messages.js';
import type { StopReason, TransitionKind } from './types.js';
import type { RecoveryKind } from './recovery-config.js';
import type { AsyncOperationSnapshot } from './operations.js';

/**
 * Events emitted by the runner. CLI and SSE handler both consume these.
 */
export interface RunnerEvents {
  text_delta: (text: string) => void;
  thinking_delta: (text: string) => void;
  tool_call_start: (id: string, name: string, input: Record<string, unknown>) => void;
  /**
   * `input` rides along because harness-refused calls (gate/pre-read/dedup/…)
   * never fire `tool_call_start` — without it the telemetry row for a refusal
   * persists `args_json='{}'`. `refusalKind` distinguishes synthesized
   * refusals from genuine tool failures (both have isError=true).
   */
  tool_call_result: (id: string, name: string, result: {
    content: string;
    isError?: boolean;
    subUsage?: ChatUsage;
    rawChars?: number;
    contentFormat?: 'text' | 'markdown' | 'json';
    structuredOutputChars?: number | null;
    input?: Record<string, unknown>;
    refusalKind?: string;
    reductionReport?: import('@mcp/code-agent/core/smart-reducers.js').ReductionReport;
    sourceTruncations?: import('@mcp/code-agent/core/tool.js').ToolSourceTruncation[];
    truncated?: boolean;
    outputId?: string;
    ledgerEntry?: import('@mcp/code-agent/core/tool-call-ledger.js').ToolCallLedgerEntry;
    guardVerdict?: import('@mcp/code-agent/core/tool.js').GuardVerdict;
    stateEpoch?: number;
  }, durationMs: number) => void;
  /**
   * Periodic heartbeat fired while a tool is in flight, and explicit
   * progress reports from cooperating tools (via `ctx.reportProgress`).
   *
   * Two roles:
   *   1. Keeps the SSE stream alive so the dashboard's StuckBanner doesn't
   *      misread legitimately long tool runs as worker stalls.
   *   2. Surfaces "still working" feedback to the user — with an optional
   *      substantive `note` ("fetched 3/10 docs") when the tool emits one.
   *
   * Suppressed for interactive waits, where the runner is correctly idle and
   * a heartbeat would confuse the UI. Explicitly unbounded execution still
   * emits heartbeats.
   */
  tool_progress: (payload: {
    id: string;
    name: string;
    elapsedMs: number;
    note?: string;
    kind?: 'heartbeat' | 'progress';
    /** Time since semantic progress; heartbeats intentionally do not reset it. */
    idleMs?: number;
  }) => void;
  /**
   * Fires once per tool block AFTER smart-reducer + buildToolResultBlock
   * shaping is complete, carrying the size the LLM actually sees in the
   * tool_result block. Pair with `tool_call_result` (which fires with the
   * RAW size) to compute per-call savings:
   *   savings = result.content.length - shapedChars
   * Index.ts merges this into the pending tool_calls entry before the
   * turn flushes via persistAssistantTurn — see the matching listener
   * there for the persistence path.
   */
  tool_call_finalized: (id: string, info: { shapedChars: number }) => void;
  /**
   * One nested tool invocation inside a code_exec script settled (success,
   * failure, or guard refusal). 103 code_exec rows could hide up to 50
   * invisible calls each before this event existed — the index.ts listener
   * persists these to coder_tool_calls with `parent_tool_use_id` set, OUT of
   * the paired tool message (they have no matching tool_use block).
   */
  nested_tool_call: (payload: import('@mcp/code-agent/core/tool.js').NestedToolCallRecord) => void;
  /** Generic lifecycle for long async operations (provider/tool/subagent/task). */
  operation_started: (payload: AsyncOperationSnapshot) => void;
  operation_progress: (payload: AsyncOperationSnapshot) => void;
  operation_finished: (payload: AsyncOperationSnapshot) => void;
  message_complete: (message: AgentMessage, usage: ChatUsage | null) => void;
  turn_start: (turn: number) => void;
  /**
   * Fired right before the runner parks on `waitForUserInput` (submit_tasks /
   * submit_plan / ask_user / execute_tasks budget / PermissionGate approval).
   * The turn blocks indefinitely here WITHOUT a following `turn_start`, so the
   * host (`index.ts`) uses this to durably checkpoint the in-flight assistant
   * message (carrying the still-pending interactive `tool_use`) — otherwise a
   * quit/close before approval loses the whole turn and the approval can never
   * be resumed. Host-internal: not forwarded over the SSE bus.
   */
  awaiting_input: (payload: { askId: string }) => void;
  /**
   * Emitted exactly once when the run terminates. `reason` is the most
   * specific applicable value from {@link StopReason}. `error` carries the
   * underlying Error for failure modes (`error`, `recovery_capped`,
   * `doom_loop`); undefined for clean exits. `transition` records the
   * recovery path that led here (when applicable) — pairs with the
   * `recoveryAttempts` map for billing/debug attribution.
   *
   * Existing consumers that only read the first 1–2 args remain
   * source-compatible; the new args default to undefined.
   */
  done: (reason: StopReason, error?: Error, transition?: TransitionKind | null) => void;
  /** Emitted when the agent calls submit_plan; payload waits for /plan-response. */
  plan_posted: (block: PlanBlock) => void;
  /** Emitted when the agent calls submit_spec; payload waits for /spec-response. */
  spec_posted: (block: SpecBlock) => void;
  /** Emitted when the agent calls ask_user; payload waits for /answer. */
  question_posted: (block: QuestionBlock) => void;
  /**
   * Emitted when the agent calls `decision_gate` — a richer multi-question
   * questionnaire of alternative approaches. Payload waits for POST /decide.
   * Mirrors `tasks_posted`: a custom-shaped SSE event (NOT a persisted
   * ContentBlock), forwarded 1:1 by runnerWiring → published as `decision`.
   */
  decision_posted: (payload: {
    id: string;
    header?: string;
    questions: Array<{
      id: string;
      header?: string;
      question: string;
      multiSelect?: boolean;
      options: Array<{ label: string; value: string; summary?: string; tradeoffs?: string }>;
    }>;
    allowFreeform?: boolean;
  }) => void;
  /**
   * Emitted by the PermissionGate when a write/execute/admin tool call pauses
   * waiting for user approval. Database writes also pause in unrestricted mode.
   * Resolved via
   * POST /tool-approval → provideUserInput(json, 'tool_approval:<toolUseId>').
   */
  tool_approval_request: (payload: {
    toolUseId: string;
    /** Chat-visible anchor block when the request came from a nested context (code_exec, subagent). */
    parentToolUseId?: string;
    toolName: string;
    argsSummary: string;
    riskClass: 'write' | 'execute' | 'admin';
    approvalKind: 'standard' | 'database_write';
    turn?: number;
    nested?: boolean;
  }) => void;
  /** Emitted when a pending tool approval is resolved (any source). */
  tool_approval_resolved: (payload: {
    toolUseId: string;
    toolName: string;
    approved: boolean;
    source: 'user' | 'interrupt' | 'abort';
    note?: string;
  }) => void;
  /** Emitted when provider/model is swapped mid-session. */
  provider_swapped: (provider: string, model: string) => void;
  /** Emitted by submit_tasks; payload is the proposed task list waiting for /tasks-response. */
  tasks_posted: (payload: {
    tool_use_id: string;
    summary: string;
    tasks: import('@mcp/code-agent/sessions/types.js').CoderTask[];
    version: number;
  }) => void;
  /** Emitted when execute_task starts processing a single task. */
  task_started: (payload: { task_id: string; mode: 'inline' | 'subagent'; started_at: string }) => void;
  /** Emitted when a task finishes (done/failed/skipped/interrupted). */
  task_finished: (payload: {
    task_id: string;
    status: import('@mcp/code-agent/sessions/types.js').TaskStatus;
    result: import('@mcp/code-agent/sessions/types.js').TaskResult | null;
    finished_at: string;
  }) => void;
  /** Emitted by `update_task` when the agent surgically patches one task
   *  (status/files/title/description) without resubmitting the whole list.
   *  Lets the dashboard sidebar refetch state-summary on the spot instead of
   *  waiting until the turn ends. */
  task_updated: (payload: {
    task_id: string;
    patch: Partial<import('@mcp/code-agent/sessions/types.js').CoderTask>;
  }) => void;
  /** Emitted by execute_tasks to render a live task execution timeline. */
  task_run_started: (payload: {
    run_id: string;
    mode: 'auto' | 'inline-all';
    total_tasks: number;
    waves: Array<{
      index: number;
      tasks: Array<{
        id: string;
        title: string;
        kind: import('@mcp/code-agent/sessions/types.js').TaskKind;
        mode: 'subagent' | 'inline';
      }>;
    }>;
  }) => void;
  task_run_task_started: (payload: {
    run_id: string;
    task_id: string;
    title: string;
    kind: import('@mcp/code-agent/sessions/types.js').TaskKind;
    wave: number;
    mode: 'subagent' | 'inline';
    started_at: string;
  }) => void;
  task_run_task_progress: (payload: {
    run_id: string;
    task_id: string;
    tool_call_count: number;
    note?: string;
    phase?: string;
    last_tool_name?: string;
    turn?: number;
    limit?: {
      maxToolCalls?: number;
      timeoutMs?: number;
      stallMs?: number;
    };
    elapsed_ms?: number;
    stall_ms?: number;
  }) => void;
  task_run_task_finished: (payload: {
    run_id: string;
    task_id: string;
    status: import('@mcp/code-agent/sessions/types.js').TaskStatus;
    summary: string;
    error?: string;
    usage?: ChatUsage;
    tool_call_count: number;
    finished_at: string;
  }) => void;
  /**
   * PR-E: emitted by `execute_tasks` when the run's token budget is
   * about to be exceeded. The dashboard renders the prompt and posts
   * the user's choice back via `runner.provideUserInput(answer, ask_id)`.
   * Tools without a UI can ignore this event — the orchestrator falls
   * back to 'cancel_pending' when no answer arrives.
   */
  budget_request: (payload: {
    ask_id: string;
    run_id: string;
    spent: number;
    cap: number;
    estimated: number;
    options: ReadonlyArray<string>;
  }) => void;
  task_run_finished: (payload: {
    run_id: string;
    /**
     * `aborted` (PR-A) signals the orchestrator intentionally declined to
     * dispatch (e.g. execute_tasks called while execution_mode='inline').
     * Distinct from `failed`, which means a subagent crashed or returned
     * an error result. The dashboard renders both as terminal but with
     * different colour/icon — `aborted` shows the optional `reject_reason`
     * tooltip.
     */
    status: 'completed' | 'failed' | 'aborted';
    /** Set when `status==='aborted'` to explain WHY the run was declined. */
    reject_reason?: string;
    total_usage: ChatUsage;
    finished_at: string;
  }) => void;
  /** Emitted when `todo_write` replaces the session's lightweight checklist. */
  todos_updated: (payload: {
    todos: import('@mcp/code-agent/tools/todo.js').TodoItem[];
  }) => void;
  /** Agent Loop v2: emitted when the stop-guard intercepts a 'completed' turn
   *  and pushes back a single recap because todos are still unfinished. */
  stop_nudged: (payload: { turn: number; recap: string }) => void;
  /** PR-2 (R1): emitted when a per-recovery-path circuit breaker exceeds
   *  its cap and the loop bails with reason='error'. */
  recovery_aborted: (payload: {
    // Sourced from RECOVERY_KINDS (recovery-config.ts) so a new recovery
    // path never drifts out of this payload again.
    kind: RecoveryKind;
    attempts: number;
    cap: number;
    contextHint: string | null;
  }) => void;
  /** Emitted when `enter_worktree` swaps the session cwd for a worktree. */
  worktree_entered: (payload: { path: string; originalCwd: string }) => void;
  /** Emitted when `exit_worktree` restores the session cwd to the project root. */
  worktree_exited: (payload: { path: string }) => void;
  /** Emitted when spawn_agents starts a parallel agent group. */
  agents_group_start: (payload: {
    groupId: string;
    /** Canonical parent tool_use id for live/history reconciliation. */
    toolUseId?: string;
    provider?: string;
    model?: string;
    /** True for a fire-and-forget background job (spawn_agent background:true). */
    background?: boolean;
    /** Background job handle — present when `background`. */
    jobId?: string;
    /** True when a prior group is being relaunched (resume_agent, or a
     *  cross-run re-emit of a still-running background job). Dashboard MERGES
     *  by groupId instead of pushing a duplicate block. */
    resumed?: boolean;
    agents: Array<{
      index: number;
      label: string;
      provider?: string;
      model?: string;
      task?: string;
      researchDepth?: 'quick' | 'standard' | 'deep' | 'exhaustive';
      softToolTarget?: number;
      softTimeTargetMs?: number;
      /** Hard tool-call cap resolved at dispatch (0/undefined = unlimited). */
      maxToolCalls?: number;
      /** Hard wall-clock cap (ms) resolved at dispatch (0/undefined = unlimited). */
      hardTimeoutMs?: number;
      status?: 'pending' | 'running' | 'completed' | 'partial' | 'error' | 'timed_out' | 'aborted';
      attempt?: number;
    }>;
  }) => void;
  /** Emitted for per-agent progress within a parallel group. */
  agent_progress: (payload: {
    groupId: string;
    /** Repeated on progress so a reattach can rebuild the canonical identity. */
    toolUseId?: string;
    agentIndex: number;
    label: string;
    task?: string;
    background?: boolean;
    jobId?: string;
    event: 'spawned' | 'heartbeat' | 'tool_call' | 'completed' | 'partial' | 'error' | 'timed_out' | 'aborted';
    status?: 'pending' | 'running' | 'completed' | 'partial' | 'error' | 'timed_out' | 'aborted';
    provider?: string;
    model?: string;
    toolCallCount?: number;
    /** Retry attempt (>=2 when this agent was resumed). */
    attempt?: number;
    note?: string;
    phase?: string;
    turn?: number;
    elapsedMs?: number;
    idleMs?: number;
    deadlineMs?: number;
    lastToolName?: string;
    limit?: {
      maxToolCalls?: number;
      timeoutMs?: number;
      stallMs?: number;
    };
    usage?: ChatUsage;
    summary?: string;
    error?: string;
    researchDepth?: 'quick' | 'standard' | 'deep' | 'exhaustive';
    softToolTarget?: number;
    softTimeTargetMs?: number;
  }) => void;
  /** Emitted when all agents in a parallel group have finished. */
  agents_group_end: (payload: {
    groupId: string;
    totalUsage: ChatUsage;
    agentCount: number;
    successCount: number;
    completedCount: number;
    partialCount: number;
    failedCount: number;
    resumableCount: number;
    /** Background job handle — present for background groups. */
    jobId?: string;
    /** Terminal disposition of a background group. */
    status?: 'completed' | 'aborted';
  }) => void;
  /**
   * Emitted when the `workflow` tool starts (or resumes) a declarative DAG
   * run. Steps carry the full roster so the dashboard can render the card
   * immediately; per-step transitions arrive via `workflow_step_update`.
   */
  workflow_run_started: (payload: {
    workflow_id: string;
    name: string;
    resumed?: boolean;
    total_waves: number;
    steps: Array<{
      id: string;
      title: string;
      profile: string;
      depends_on: string[];
      wave: number;
      status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped';
    }>;
  }) => void;
  /** Per-step lifecycle transition within a workflow run. */
  workflow_step_update: (payload: {
    workflow_id: string;
    step_id: string;
    status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped';
    /** agents_group id of the wave this step ran in — links to live agent lanes. */
    group_id?: string;
    summary?: string;
    error?: string;
    tool_call_count?: number;
    usage?: ChatUsage;
  }) => void;
  /** Terminal disposition of a workflow run. */
  workflow_run_finished: (payload: {
    workflow_id: string;
    status: 'completed' | 'partial' | 'failed' | 'aborted';
    completed_count: number;
    failed_count: number;
    skipped_count: number;
    total_usage: ChatUsage;
  }) => void;
  /** Emitted when the runner auto-continues after hitting maxTurns. */
  auto_continue: (count: number, max: number) => void;
  /**
   * Emitted per-turn with honest context accounting — the SAME number the
   * compaction gates act on. `prompt_tokens` is the TRUE prompt size of the
   * last provider call (adapter-normalized `prompt_tokens_total`: includes
   * cached slices on Anthropic-style APIs) or the calibrated tokenizer
   * estimate when the provider omits usage. Single source of truth for the
   * dashboard context bar — replaces mixing live `input_tokens` with the
   * persisted cache-blind `last_turn_input_tokens` (the "70k jumps to 100k
   * on send" bug).
   */
  context_status: (payload: {
    turn: number;
    /** True prompt size (tokens) of the last provider call. */
    prompt_tokens: number;
    /** Where the number came from: provider usage or tokenizer estimate. */
    source: 'usage' | 'estimate';
    /** Effective context window of the active model (window − reserved output). */
    context_window: number;
    /** prompt_tokens / context_window (0 when window unknown). */
    ratio: number;
  }) => void;
  /** Emitted when a fallback provider is activated due to persistent errors. */
  fallback_activated: (payload: {
    from: { provider: string; model: string };
    to: { provider: string; model: string };
    error: string;
  }) => void;
  /** Emitted when the runner compacts history during auto-continue so the
   *  dashboard can show the user which turns were summarized away. */
  history_compacted: (payload: {
    strategy: 'summarizer' | 'deterministic' | 'none';
    pruned_messages: number;
    pruned_chars: number;
    total_chars_before: number;
    total_chars_after: number;
    auto_continue: number;
    /**
     * A6 — WHICH gate routed the run into Compacting: a loop-aware reason
     * ('polling-loop' | 'stuck-progress' | 'cumulative'), a size gate
     * ('token-budget' | 'body-after-prefix'), or 'context-overflow' (the
     * provider rejected the payload). Absent on legacy emit sites.
     */
    trigger?: string;
  }) => void;
  /**
   * Emitted exactly once at the start of `run()`. Carries a fresh runId so
   * downstream observers can correlate the rest of the lifecycle events
   * even when several `runCoder()` calls share the same persistent session.
   */
  run_started: (payload: {
    runId: string;
    provider: string;
    model: string;
    profile: string | null;
    planMode: boolean;
    maxTurns: number;
    /**
     * Ultra execution identity — present only when Ultra is active for this
     * run. 'session' = the sticky execution-mode toggle; 'turn' = the
     * `ultracode` keyword triggered Ultra for THIS run only (nothing
     * persisted). The dashboard renders the Ultra chip from this.
     */
    ultra?: 'session' | 'turn';
  }) => void;
  /**
   * Emitted right before each `provider.chat()` call. Useful for measuring
   * cache-hit rate against retries: a turn that re-enters this event after
   * a 400/401 retry has the same `turn` index as the previous emission.
   */
  provider_call: (payload: {
    runId: string;
    turn: number;
    provider: string;
    model: string;
    toolCount: number;
    historyChars: number;
  }) => void;
  /**
   * Emitted alongside `provider_call` with the temperature the runner picked
   * for this turn. `source` records WHICH layer of the precedence chain won
   * (session/role/agent/default), or `'skipped'` when the model rejected
   * sampling. Dashboard renders this as a per-turn "T" indicator.
   */
  temperature_resolved: (payload: {
    runId: string;
    turn: number;
    provider: string;
    model: string;
    agent: import('@mcp/code-agent/agents/index.js').AgentId | null;
    temperature: number | undefined;
    source: 'session' | 'role' | 'agent' | 'default' | 'skipped';
    reason?: 'reasoning_model' | 'thinking_enabled';
  }) => void;
  /**
   * Emitted once per turn, after the assistant message lands and before
   * tool execution starts. Empty `names` means "no tool calls — turn ends
   * with assistant text". Lets the dashboard preview the upcoming batch.
   */
  tool_batch: (payload: {
    runId: string;
    turn: number;
    count: number;
    names: string[];
  }) => void;
  /**
   * Emitted whenever a tool invocation is refused for a safety reason
   * (plan mode, task scope, shell allowlist, sandbox required, admin
   * override required). Carries enough detail to surface a banner to
   * the user without parsing the result text. The reason union mirrors
   * `PolicyReason` from `core/policy.ts` plus the legacy `shell_allowlist`
   * value (kept for shell.ts which gates internally rather than via
   * the policy module).
   */
  blocked: (payload: {
    runId: string;
    turn: number;
    tool: string;
    reason:
    | 'plan_mode'
    | 'spec_mode'
    | 'task_scope'
    | 'shell_allowlist'
    | 'sandbox_required'
    | 'admin_required'
    | 'policy_hard_block';
    detail?: string;
  }) => void;
  /**
   * Quality v2, A2 — Emitted when the next-turn nudge builder waited for
   * the prior turn's classifier Promise but it didn't resolve within the
   * timeout. Low-volume diagnostic; not a hard error. Operators tune the
   * timeout (`MCP_QUALITY_NUDGE_WAIT_TIMEOUT_MS`) using this signal.
   */
  quality_nudge_missed: (payload: { runId: string; turn: number }) => void;
  /**
   * Emitted when the QualityWatchdog LLM (Apêndice 3 — Parte A)
   * returns a non-'ok' verdict for the current session. Dashboard
   * renders a separate banner with the LLM's reason text; the runner
   * also injects a one-shot system reminder on the next turn when
   * the verdict's `recommendedAction` is 'nudge' or 'stop'.
   */
  quality_watchdog_alert: (payload: {
    turn: number;
    sessionId: number;
    suspectTool: string;
    verdict: 'ok' | 'warn' | 'flagged' | 'error';
    confidence: number;
    reason: string;
    recommendedAction: 'stop' | 'nudge' | 'ok';
    providerId: string;
    modelId: string;
  }) => void;
  /**
   * Emitted when an active loop-detection guard fires. Lets the
   * dashboard show a banner instead of just logging to the server
   * terminal — historically the user only learned about a loop by
   * noticing the session was burning tokens with no progress. The
   * snapshot carries the internal state so future debugging can answer
   * "WHY did this guard fire and the others didn't?" from persisted event
   * evidence. Phase 3 of the "living company"
   * restructure (Apêndice 3).
   */
  tool_loop_intervention: (payload:
    | {
        /**
         * Loop-guard refusal — agent is cycling and the runner stopped
         * (refused) or terminated (aborted) the call.
         */
        kind: 'doom-loop-strict' | 'doom-loop-fuzzy' | 'dominance';
        turn: number;
        /** Tool name (single for dominance; comma-joined for strict/fuzzy). */
        toolName: string;
        /** Count that triggered the guard. */
        count: number;
        /** Threshold the count crossed. */
        threshold: number;
        /** Sliding window size (turns). */
        window: number;
        /** Whether this fired in "refused" mode (just blocked the call) or
         *  "aborted" mode (terminated the whole run). */
        severity: 'refused' | 'aborted';
        /** Snapshot of the three guard arrays so the dashboard can show
         *  WHY the other guards didn't fire. */
        snapshot: {
          strict: string[];
          fuzzy: string[];
          dominance: Array<{ name: string; hadText: boolean }>;
        };
        /** Short human reason for UI. */
        reason: string;
      }
    | {
        /**
         * PR 5 — failure-streak. A tool's `isError=true` results stacked
         * past the configured threshold. It catches failure patterns where
         * arguments legitimately rotate, which invocation-local tuple guards
         * cannot identify.
         *
         * `severity: 'informational'` → reminder injected, the call's
         * own error result is STILL delivered (model sees both).
         * `severity: 'refused'`       → content REPLACED with refusal,
         * and the orchestrator routes to Planning.
         */
        kind: 'failure-streak';
        turn: number;
        toolName: string;
        /** Consecutive failure count that triggered the verdict. */
        count: number;
        /** Turn of the very first failure in the current streak. */
        firstFailureTurn: number;
        /** First ~200 chars of the most recent error content. */
        lastError: string;
        severity: 'informational' | 'refused';
        reason: string;
      }
  ) => void;
  /**
   * Frente E — BT state dwell telemetry. Fires once per state transition,
   * carrying how long the BT spent in the state it just left and which
   * event triggered the transition. Useful for spotting pathological
   * profiles (Executing dwells of multiple minutes, Compacting taking
   * >30s, Recovering looping). Dashboard can render this as a per-node
   * time histogram; bare CLI consumers may ignore it.
   *
   * Phase-1 telemetry: emitted but NOT persisted to any table. If we
   * later want a coder_session_events table, the producer is already
   * in place.
   */
  bt_state_dwell: (payload: {
    runId: string;
    /** Node we just left (the one whose execute() resolved with `event`). */
    state: import('./machine/types.js').NodeState;
    /** Event the node produced, driving the transition. */
    event: import('./machine/types.js').BehaviorEventKind;
    /** Wall-clock ms spent in `state` between entry and the transition. */
    dwellMs: number;
    /** Turn counter at the time of the transition — helps correlate. */
    turn: number;
  }) => void;
  /**
   * Emitted by `ToolContext.setSessionAgent` when the session's agent
   * is flipped mid-run (`plan → build` after submit_plan approval,
   * `spec → build` after submit_spec approval, manual agent switches via
   * the dashboard). The dashboard's `AgentPicker` listens on this event
   * via SSE and updates its selector without a manual refetch.
   *
   * Carries only the new agent id; the runner has already mutated its
   * own `opts.{planMode, agentId}` by the time this fires.
   */
  session_agent_changed: (payload: {
    agent: import('@mcp/code-agent/agents/index.js').AgentId;
  }) => void;
  /**
   * Session Drive write — the agent saved a `remember` note or a sub-agent
   * investigation was auto-captured. The SSE layer forwards it so the
   * dashboard's Drive panel refetches live instead of polling.
   */
  session_drive_changed: (payload: { kind: 'memory' | 'investigation' }) => void;
  /**
   * A draw.io diagram was created/updated by an agent tool (diagram_create /
   * diagram_update). `xml` rides along for instant render; the `.drawio` file
   * is the durable source for a late-mounting panel. The SSE layer forwards it
   * so the chat panel opens and the editor refreshes live.
   */
  diagram_changed: (payload: { path: string; xml: string }) => void;
  /**
   * `diagram_export` asks the LIVE embedded editor (if open) to render the
   * named diagram to an image and persist it next to the `.drawio` file. No-op
   * when no panel/editor is open for the session.
   */
  diagram_export_request: (payload: { path: string; format: 'svg' | 'png' }) => void;
}
