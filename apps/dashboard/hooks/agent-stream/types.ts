export interface ToolCallEvent {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  /** `image` is set for tools that return a picture (preview_screenshot,
   *  view_image) so the UI can show it inline under the tool call. */
  result?: { content: string; isError?: boolean; image?: { mediaType: string; base64: string } };
  durationMs?: number;
  status: 'running' | 'awaiting_approval' | 'done' | 'error';
  /** `Date.now()` stamped when `tool_call_start` arrived. Used to render
   *  "running Xs" while the tool is in flight, AND as a fallback for
   *  `elapsedMs` if the worker is on an older build that doesn't emit
   *  `tool_progress`. */
  startedAt?: number;
  /** Latest `tool_progress.elapsedMs` from the runner. Updated whenever
   *  the worker's per-tool heartbeat (or `ctx.reportProgress`) fires.
   *  Cleared on `tool_call_result`. */
  elapsedMs?: number;
  /** Optional substantive progress note emitted by cooperative tools via
   *  `ctx.reportProgress` (e.g. "fetched 3/10 docs"). Trimmed to ~200
   *  chars on the runner side. */
  progressNote?: string;
  /**
   * Pending PermissionGate approvals anchored to this block. An array —
   * one code_exec block can stack several nested tool requests. Cleared
   * as each `tool_approval_resolved` arrives.
   */
  approvals?: PendingToolApproval[];
}

/** A PermissionGate request waiting for the user's verdict. */
export interface PendingToolApproval {
  toolUseId: string;
  /** Chat-visible anchor block id (code_exec / spawn_agent) when nested. */
  parentToolUseId?: string;
  toolName: string;
  argsSummary: string;
  riskClass: 'write' | 'execute' | 'admin';
  nested?: boolean;
  receivedAt: number;
}

export interface PlanPrompt {
  id: string;
  plan: string;
  resolved?: 'approved' | 'rejected';
  /**
   * Hint emitted by the coder when calling submit_plan: 'informational'
   * means the plan is an answer-only deliverable (no edit/shell follow-up).
   * The dashboard surfaces a quick-approve cue for these.
   */
  kind?: 'informational' | 'mutating';
}

/**
 * SDD mode artifact emitted by `submit_spec` (or
 * `submit_specification_to_master`). `body` is the full markdown spec; the
 * runner persisted it to `spec_path` (`.mcp/specs/<slug>-<unix>.md`).
 */
export interface SpecPrompt {
  id: string;
  name: string;
  body: string;
  spec_path: string;
  parent_id?: string;
  drive_path?: string;
  resolved?: 'approved' | 'rejected';
}

export interface QuestionPrompt {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  /** When true + options: user picks MULTIPLE and confirms (checkbox-style). */
  multiSelect?: boolean;
  resolved?: string;
}

// ─── Decision gate (decision_gate tool) ───────────────────────
export interface DecisionOption {
  label: string;
  value: string;
  summary?: string;
  tradeoffs?: string;
}
export interface DecisionQuestion {
  id: string;
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: DecisionOption[];
}
/** User's choices, keyed by question id. `selected` holds chosen option values; `freeform` may be the whole answer when no option was selected. */
export type DecisionAnswers = Record<string, { selected: string[]; freeform?: string }>;
export interface DecisionPrompt {
  id: string;
  header?: string;
  questions: DecisionQuestion[];
  allowFreeform?: boolean;
  /** Read-only answers once resolved (history rendering). */
  resolved?: DecisionAnswers;
}

export type StreamTaskMode = 'inline' | 'subagent';
export type StreamTaskExecutionMode = 'inline' | 'all-subagent' | 'smart' | 'per-task';
export type StreamTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';

export interface StreamTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  references?: Array<{ type: string; value: string; file?: string; lines?: string; note?: string }>;
  depends_on: string[];
  suggested_mode: StreamTaskMode;
  estimated_complexity: 'small' | 'medium' | 'large';
  status: StreamTaskStatus;
  mode_used?: StreamTaskMode;
  result?: {
    summary: string;
    files_modified: string[];
    errors?: string;
    sandbox_violations?: string[];
  };
  started_at?: string;
  finished_at?: string;
}

export interface TasksPrompt {
  tool_use_id: string;
  summary: string;
  tasks: StreamTask[];
  version: number;
  /** Set after the user responds. Stops re-rendering the action buttons. */
  resolved?: 'approved' | 'rejected';
}

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type TaskRunTaskStatus = StreamTaskStatus;
export type TaskRunMode = 'auto' | 'inline-all';

export interface TaskRunTask {
  id: string;
  title: string;
  kind: 'investigate' | 'implement' | 'verify';
  wave: number;
  mode: StreamTaskMode;
  status: TaskRunTaskStatus;
  toolCallCount: number;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  usage?: Usage;
  progressNote?: string;
  phase?: string;
  lastToolName?: string;
  turn?: number;
  limit?: {
    maxToolCalls?: number;
    timeoutMs?: number;
    stallMs?: number;
  };
  elapsedMs?: number;
  stallMs?: number;
}

export interface TaskRunWave {
  index: number;
  taskIds: string[];
}

export interface TaskRunState {
  runId: string;
  mode: TaskRunMode;
  status: TaskRunStatus;
  totalTasks: number;
  waves: TaskRunWave[];
  tasks: TaskRunTask[];
  totalUsage?: Usage;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentAttachment {
  name: string;
  mediaType: string;
  base64?: string;
  text?: string;
}

// ─── Parallel agents ──────────────────────────────────────────

export type AgentStatus = 'pending' | 'running' | 'completed' | 'error' | 'timed_out' | 'aborted';

export interface ParallelAgent {
  index: number;
  label: string;
  status: AgentStatus;
  toolCallCount: number;
  provider?: string;
  model?: string;
  usage?: Usage;
  summary?: string;
  error?: string;
  /** The prompt/task the agent received — from the live stream payload
   *  (agents_group_start) and from persisted history (the tool input). */
  task?: string;
  /** Subagent kind (e.g. 'explore' | 'implement'), from history. */
  agentType?: string;
  progressNote?: string;
  phase?: string;
  turn?: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  lastToolName?: string;
  /** Retry attempt (>=2 when this agent was resumed via resume_agent). */
  attempt?: number;
  /** Terminal stop reason, from history — shown in the detail modal. */
  reason?: string;
}

export interface AgentsGroup {
  groupId: string;
  agents: ParallelAgent[];
  provider?: string;
  model?: string;
  totalUsage?: Usage;
  status: 'running' | 'completed';
  /** Fire-and-forget background job (spawn_agent background:true). */
  background?: boolean;
  /** Background job handle — for collect/notification correlation. */
  jobId?: string;
}

// ─── Stream blocks ────────────────────────────────────────────

export type StreamActivityStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'aborted';
export type StreamActivityKind = 'provider' | 'tool' | 'spawn_agent' | 'subagent' | 'task' | 'operation';

export interface StreamActivityBlock {
  type: 'activity';
  id: string;
  kind: StreamActivityKind;
  label: string;
  status: StreamActivityStatus;
  phase?: string;
  note?: string;
  startedAt: number;
  lastEventAt: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  parentOpId?: string;
}

export type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | StreamActivityBlock
  | { type: 'tool'; call: ToolCallEvent }
  | { type: 'plan'; plan: PlanPrompt }
  | { type: 'spec'; spec: SpecPrompt }
  | { type: 'question'; question: QuestionPrompt }
  | { type: 'decision'; decision: DecisionPrompt }
  | { type: 'tasks'; tasks: TasksPrompt }
  | { type: 'task_run'; run: TaskRunState }
  | { type: 'agents'; group: AgentsGroup };

export interface AssistantTurn {
  /** Blocks in arrival order — text and tool_use intercalados como o modelo emitiu. */
  blocks: StreamBlock[];
}

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Running totals accumulated since the current `sendMessage` started.
 * Reset to zero on every new send so the UI can show "this run added +X cache".
 */
export interface RunDelta {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Lightweight todo item maintained by the `todo_write` native tool. */
export interface TodoItem {
  /** Stable id (8-char hex) assigned server-side. Optional during the upgrade window for sessions with legacy payloads. */
  id?: string;
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Live context metrics emitted per-turn — the SAME number the runner's
 * compaction gates act on. `prompt_tokens` is the TRUE prompt size of the
 * last provider call (cache-inclusive on Anthropic-style APIs) or the
 * calibrated tokenizer estimate when the provider omits usage. Single
 * source of truth for the header context bar.
 */
export interface ContextStatus {
  turn: number;
  /** True prompt size (tokens) of the last provider call. */
  prompt_tokens: number;
  /** Where the number came from: provider usage or tokenizer estimate. */
  source: 'usage' | 'estimate';
  /** Effective context window of the active model (window − reserved output). */
  context_window: number;
  /** prompt_tokens / context_window (0 when window unknown). */
  ratio: number;
}

export interface IndexStatus {
  isIndexed: boolean;
  mcpAvailable: boolean;
}

/**
 * Set when the server returned 409 INTERACTION_PENDING because the live runner
 * was blocked inside an interactive tool. Lets the UI render an explicit
 * "interrupt and resend" choice instead of a generic error toast — matches
 * the enqueue-and-attach contract of POST /messages with `interject:true`.
 */
export interface InteractionPending {
  /** Server-supplied error code ('INTERACTION_PENDING'). */
  code: string;
  /** Human-readable message from the server. */
  message: string;
  /** The original message the user tried to send — re-submit when interrupting. */
  pendingContent: string;
}

/**
 * Bus event payload emitted whenever a loop-detection guard or related
 * intervention fires. Dashboard renders a banner so the user sees the
 * intervention live instead of having to scrape the server log.
 *
 * Discriminated by `kind`: the guard variants carry the full
 * count/threshold/window shape and usually a snapshot; other intervention
 * families carry their own metadata and do not include a snapshot.
 */
export type ToolLoopIntervention =
  | (ToolLoopGuardIntervention & { receivedAt: number })
  | (FailureStreakIntervention & { receivedAt: number })
  | (LoopEnforcedIntervention & { receivedAt: number })
  | (DupResultMarkerIntervention & { receivedAt: number });

export interface ToolLoopGuardIntervention {
  kind: 'dup-call-cap' | 'doom-loop-strict' | 'doom-loop-fuzzy' | 'dominance';
  turn: number;
  toolName: string;
  count: number;
  threshold: number;
  window: number;
  severity: 'refused' | 'aborted';
  reason: string;
  /** Diagnostic snapshot of the three guard arrays — explains WHY
   *  the other guards didn't fire (e.g. fuzzy was 4/6 when dominance
   *  fired). Current servers include this for guard events; optional here
   *  so older or malformed stream payloads cannot crash the dashboard. */
  snapshot?: {
    strict: string[];
    fuzzy: string[];
    dominance: Array<{ name: string; hadText: boolean }>;
  };
}

export interface FailureStreakIntervention {
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

export interface LoopEnforcedIntervention {
  kind: 'loop-enforced';
  turn: number;
  toolName: string;
  /**
   * Cross-cycle hard-refusal count for this exact tool+args. Counts refusals
   * that survive the per-Planning dedup reset.
   */
  count: number;
  severity: 'enforced';
  reason: string;
}

export interface DupResultMarkerIntervention {
  kind: 'dup-result-marker';
  /**
   * `'informational'` for the light + medium tiers (content delivered
   * with a marker prefix, no error). `'refused'` for the hard-refuse
   * tier (content REPLACED with refusal text, `is_error` set on the
   * tool result). The dashboard banner only renders the latter — the
   * light/medium tiers don't deserve a permanent visual interrupt.
   */
  severity: 'informational' | 'refused';
  /**
   * Three-tier escalation indicator, derived from the runner's
   * `matches.length` count against `RESULT_DUP_ESCALATION_{WARN,REFUSE}`:
   *   - `'light'`   → 2nd identical hit (`matches.length === 1`),
   *                   light marker prefixed, content delivered.
   *   - `'medium'`  → WARN tier reached (`matches.length >= _WARN`),
   *                   sharper marker prefixed, content still delivered.
   *   - `'refused'` → REFUSE tier reached (`matches.length >= _REFUSE`),
   *                   content replaced with refusal text.
   */
  escalationLevel: 'light' | 'medium' | 'refused';
  /** Human-readable hit number for this identical content (1 = first
   *  fetch; markers never fire on 1; 2 = first duplicate; 3 = warn tier;
   *  4+ = refuse tier with default thresholds). */
  hitCount: number;
  toolName: string;
  /** Turn where the original duplicate content was first seen. */
  originalTurn: number;
  currentTurn: number;
  /** `'light'` = full content delivered with marker prefix.
   *  `'medium'` = head excerpt + output_id pointer (large outputs).
   *  Only meaningful when `escalationLevel !== 'refused'`. */
  mode: 'light' | 'medium';
  /** True when the original tool_result block was elided by
   *  post-compact cleanup. Drives the marker text variant. */
  priorIsCompacted: boolean;
}

/**
 * Per-node runtime status for the chat pipeline runtime overlay.
 * Reduced from the SSE `pipeline_node_*` events. The dashboard mini-graph
 * colors nodes by `status`.
 */
export type PipelineNodeRuntimeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface PipelineRuntimeState {
  /** `pipeline_executions.id`. */
  executionId: number;
  /** `pipelines.id`. */
  pipelineId: number;
  /** Aggregate state machine — mirrors `pipeline_executions.status`. */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
  /** Active node id (null when terminal). */
  currentNodeId: string | null;
  /** Per-node status keyed by node id. */
  nodes: Record<
    string,
    {
      status: PipelineNodeRuntimeStatus;
      label?: string;
      kind?: 'agent' | 'validate';
      verdict?: 'pass' | 'fail' | 'review' | null;
      outcome?: string | null;
      outputPreview?: string;
      error?: string;
    }
  >;
  /** Last error message from a failed run (terminal). */
  error: string | null;
  /**
   * Set when `requires_confirmation` paused the run between stages. The
   * dashboard renders an Approve button (which calls `/confirm`) instead
   * of the normal Resume button. Cleared on confirm/abort/resume.
   */
  awaitingConfirmation?: boolean;
}

export interface SessionState {
  streaming: boolean;
  currentTurn: AssistantTurn | null;
  doneReason: string | null;
  error: string | null;
  lastUsage: Usage | null;
  /** Sum of every message_complete usage since the current run started. */
  runDelta: RunDelta;
  /** True when the current stream was reattached to a background run. */
  reattached: boolean;
  /** Lightweight checklist from the `todo_write` tool. Replaced whole on each SSE event. */
  todos: TodoItem[];
  /** Per-turn context metrics for progress indicator. */
  contextStatus: ContextStatus | null;
  /** Whether the project is indexed and MCP tools are available. */
  indexStatus: IndexStatus | null;
  /**
   * 409 INTERACTION_PENDING handshake state. Null when the last send was
   * accepted; populated when the server rejected because the runner was
   * inside an interactive wait. Cleared on the next successful send or
   * when the user dismisses.
   */
  interactionPending: InteractionPending | null;
  /**
   * Latest snapshot of the in-flight chat pipeline (PR-3). Null when no
   * pipeline has run in this session yet. Sticks around after terminal
   * states so the user can read the final outcome until they dismiss.
   */
  pipelineRuntime: PipelineRuntimeState | null;
  /**
   * Monotonic counter bumped on every event that mutates the live goal /
   * tasks / todos state (tasks_posted, task_started, task_finished,
   * task_updated, todos_updated). The session sidebar combines this with
   * the per-turn refreshKey so status changes show up mid-turn instead of
   * waiting until the model finishes the turn.
   */
  sidebarRefreshTick: number;
  /**
   * Monotonic counter bumped only when the task LIST identity or approval
   * changes (`tasks_posted` + `message_complete`) — NOT on every task status
   * transition. Keys the dashboard's `/tasks` refetch so the persisted
   * TaskListReview card reflects the latest submitted/approved list mid-run,
   * instead of waiting for the run to end (`doneReason`). Kept separate from
   * `sidebarRefreshTick` (which bumps on every status change) to avoid a fetch
   * storm during multi-task execution.
   */
  tasksRefreshTick: number;
  /**
   * Monotonic counter bumped on every `session_snapshot_changed` SSE event.
   * The Snapshots panel re-fetches its list/diff whenever this changes,
   * so the user sees new agent edits land in the review UI live.
   */
  snapshotTick: number;
  /**
   * PermissionGate approvals waiting for the user's verdict, oldest first.
   * Mirrors the per-block `ToolCallEvent.approvals` so the banner above the
   * message list can act on requests whose anchor block scrolled away.
   * Cleared when the run ends or a new send resets the turn.
   */
  pendingApprovals: PendingToolApproval[];
  /**
   * `Date.now()` of the last event observed on the stream. Used by the
   * stuck-detection banner — if `streaming` stays true but this stops
   * advancing for >30s the dashboard shows "Worker idle for Xs —
   * possible stall". Null until first event arrives.
   */
  lastEventAt: number | null;
  /**
   * Set while the BLOCKING task-preflight analysis runs on the first message
   * of a fresh session — the chat shows an "Analyzing the task…" indicator
   * instead of the bare spinner. Set on send (fresh first message), cleared on
   * the first SSE event of the run and on terminal (done/error).
   */
  preflight: { startedAt: number } | null;
}

/**
 * A single entry in the worker log. Wraps the raw SSE event plus
 * categorisation derived from the event name (when the server didn't
 * tag it explicitly via `worker_log`).
 */
export interface WorkerLogEntry {
  /** Local capture time (Date.now). Server-side `ts` is preferred when present in `data.ts`. */
  ts: number;
  /** Raw event name from the SSE stream (e.g. `tool_call_start`, `worker_log`, `quality_watchdog_alert`). */
  event: string;
  /** Severity. Derived from event semantics or the explicit `level` field on `worker_log` payloads. */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Coarse bucket for filters. */
  category:
    | 'route'
    | 'pool'
    | 'worker'
    | 'runner'
    | 'tool'
    | 'quality'
    | 'provider'
    | 'lifecycle'
    | 'message'
    | 'other';
  /** Short human-readable headline. For `worker_log` payloads this is `data.message`; for others it's derived. */
  message: string;
  /** Raw payload — shown when the entry is expanded. */
  data: unknown;
}

export const ZERO_DELTA: RunDelta = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

export const EMPTY_STATE: SessionState = {
  streaming: false,
  currentTurn: null,
  doneReason: null,
  error: null,
  lastUsage: null,
  runDelta: ZERO_DELTA,
  reattached: false,
  todos: [],
  contextStatus: null,
  indexStatus: null,
  interactionPending: null,
  pipelineRuntime: null,
  sidebarRefreshTick: 0,
  tasksRefreshTick: 0,
  snapshotTick: 0,
  pendingApprovals: [],
  lastEventAt: null,
  preflight: null,
};

export type SessionPatch =
  | Partial<SessionState>
  | ((s: SessionState) => Partial<SessionState>);

export type UpdateSession = (sid: number, patch: SessionPatch) => void;
