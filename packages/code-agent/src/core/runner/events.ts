import type {
  AgentMessage,
  ChatUsage,
  PlanBlock,
  SpecBlock,
  QuestionBlock,
} from '@mcp/code-agent/core/messages.js';
import type { StopReason, TransitionKind } from './types.js';
import type { AsyncOperationSnapshot } from './operations.js';

/**
 * Events emitted by the runner. CLI and SSE handler both consume these.
 */
export interface RunnerEvents {
  text_delta: (text: string) => void;
  thinking_delta: (text: string) => void;
  tool_call_start: (id: string, name: string, input: Record<string, unknown>) => void;
  tool_call_result: (id: string, name: string, result: { content: string; isError?: boolean; subUsage?: ChatUsage; rawChars?: number }, durationMs: number) => void;
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
   * Suppressed for tools whose timeoutMs is `Infinity` (interactive /
   * repeatable) — there the runner is correctly idle, and a heartbeat
   * would confuse the UI.
   */
  tool_progress: (payload: { id: string; name: string; elapsedMs: number; note?: string }) => void;
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
  /** Generic lifecycle for long async operations (provider/tool/subagent/task). */
  operation_started: (payload: AsyncOperationSnapshot) => void;
  operation_progress: (payload: AsyncOperationSnapshot) => void;
  operation_finished: (payload: AsyncOperationSnapshot) => void;
  message_complete: (message: AgentMessage, usage: ChatUsage | null) => void;
  turn_start: (turn: number) => void;
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
    kind: 'provider-400-retry' | 'provider-401-refresh' | 'provider-transient-retry' | 'provider-fallback' | 'compact-failure';
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
    provider?: string;
    model?: string;
    agents: Array<{ index: number; label: string; provider?: string; model?: string; task?: string }>;
  }) => void;
  /** Emitted for per-agent progress within a parallel group. */
  agent_progress: (payload: {
    groupId: string;
    agentIndex: number;
    label: string;
    event: 'spawned' | 'heartbeat' | 'tool_call' | 'completed' | 'error' | 'timed_out' | 'aborted';
    status?: 'pending' | 'running' | 'completed' | 'error' | 'timed_out' | 'aborted';
    provider?: string;
    model?: string;
    toolCallCount?: number;
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
  }) => void;
  /** Emitted when all agents in a parallel group have finished. */
  agents_group_end: (payload: {
    groupId: string;
    totalUsage: ChatUsage;
    agentCount: number;
    successCount: number;
  }) => void;
  /** Emitted when the runner auto-continues after hitting maxTurns. */
  auto_continue: (count: number, max: number) => void;
  /** Emitted per-turn with context size metrics for the dashboard. */
  context_status: (payload: {
    history_chars: number;
    turn: number;
    max_turns: number;
    auto_continue_count: number;
    auto_continue_max: number;
    last_turn_input_tokens: number;
    context_window: number | null;
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
   * Emitted when one of the four loop-detection guards fires. Lets the
   * dashboard show a banner instead of just logging to the server
   * terminal — historically the user only learned about a loop by
   * noticing the session was burning tokens with no progress. The
   * snapshot carries the internal state so future debugging can answer
   * "WHY did this guard fire and the others didn't?" without needing
   * to enable `CODER_DOOM_LOOP_DEBUG`. Phase 3 of the "living company"
   * restructure (Apêndice 3).
   */
  tool_loop_intervention: (payload:
    | {
        /**
         * Loop-guard refusal — agent is cycling and the runner stopped
         * (refused) or terminated (aborted) the call.
         */
        kind: 'dup-call-cap' | 'doom-loop-strict' | 'doom-loop-fuzzy' | 'dominance';
        turn: number;
        /** Tool name (single) for dup-call/dominance; comma-joined for strict/fuzzy. */
        toolName: string;
        /** Count that triggered the guard (e.g. 5 for dup-call, 6 for fuzzy). */
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
         * past the configured threshold. Distinct from `dup-call-cap`
         * (same args, irrespective of error) and `dup-result-marker`
         * (same RESULT content). Only this kind fires on failure
         * patterns where the args legitimately rotate.
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
    | {
        /**
         * Dup-result marker — agent re-fetched identical content. The
         * runner reacts in one of three tiers depending on how many
         * prior identical hits exist in the window:
         *
         *   - `escalationLevel: 'light'`   → light marker prefixed; full content delivered.
         *   - `escalationLevel: 'medium'`  → warn marker prefixed (sharper language); full content still delivered.
         *   - `escalationLevel: 'refused'` → hard refuse; content REPLACED with refusal message and `is_error=true`. Dashboard should render this in the banner.
         *
         * Distinct from the loop-guard variants both semantically and
         * in the dashboard's counts. When `severity: 'informational'`
         * the runner did NOT block the call; when `'refused'`, it did.
         */
        kind: 'loop-enforced';
        turn: number;
        toolName: string;
        /**
         * Cross-cycle hard-refusal count for this exact tool+args. Counts
         * refusals that survive the per-Planning dedup reset, so it only
         * fires for genuinely insistent loops (e.g. ≥2 refused cycles).
         */
        count: number;
        /**
         * `'enforced'` — the runner injected a strong <system-reminder>
         * (available tools + "break out of the loop"). The supervisor
         * records a `loop_enforced` incident and may escalate.
         */
        severity: 'enforced';
        reason: string;
      }
    | {
        kind: 'dup-result-marker';
        severity: 'informational' | 'refused';
        /** Three-tier escalation indicator — drives dashboard render. */
        escalationLevel: 'light' | 'medium' | 'refused';
        /** Human-readable hit number for this content (1 = first fetch,
         *  marker never emits for 1; 2 = first duplicate; etc). */
        hitCount: number;
        toolName: string;
        /** Turn where the original duplicate content was first seen. */
        originalTurn: number;
        currentTurn: number;
        /** `'light'` = full content delivered, `'medium'` = head excerpt + output_id.
         *  Only meaningful when `escalationLevel !== 'refused'`. */
        mode: 'light' | 'medium';
        /** True when the original tool_result block was elided by
         *  post-compact cleanup. Drives the marker text variant. */
        priorIsCompacted: boolean;
      }
  ) => void;
  /**
   * deepThink — emitted right before the auxiliary (cheap) model is asked
   * to produce a pre-thought for the upcoming main-model turn. Only fires
   * when `RunnerOptions.deepThink` is on AND `shouldRunPreThink` passes.
   */
  pre_think_started: (payload: {
    runId: string;
    turn: number;
    model: string;
    provider: string;
  }) => void;
  /** Streamed chunk of the auxiliary's pre-thought text. UI renders these
   *  live, mirroring how `thinking_delta` works for native extended-thinking. */
  pre_think_delta: (payload: {
    runId: string;
    turn: number;
    text: string;
  }) => void;
  /** Auxiliary call finished successfully. `text` is the full concatenated
   *  pre-thought (already trimmed). `usage` is the auxiliary's token usage —
   *  the runner also accumulates it into `RunResult.totalUsage.aux_*`. */
  pre_think_completed: (payload: {
    runId: string;
    turn: number;
    text: string;
    usage: ChatUsage | undefined;
  }) => void;
  /** Auxiliary call failed or timed out. The main-model turn proceeds
   *  WITHOUT the prefilled `<thinking>` block — degrade silently. */
  pre_think_failed: (payload: {
    runId: string;
    turn: number;
    error: string;
  }) => void;
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
}
