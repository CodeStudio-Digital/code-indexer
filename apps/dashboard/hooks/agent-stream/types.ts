export interface ToolCallEvent {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  durationMs?: number;
  status: 'running' | 'done' | 'error';
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
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  resolved?: string;
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

export interface AgentAttachment {
  name: string;
  mediaType: string;
  base64?: string;
  text?: string;
}

// ─── Parallel agents ──────────────────────────────────────────

export type AgentStatus = 'pending' | 'running' | 'completed' | 'error';

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
}

export interface AgentsGroup {
  groupId: string;
  agents: ParallelAgent[];
  provider?: string;
  model?: string;
  totalUsage?: Usage;
  status: 'running' | 'completed';
}

// ─── Stream blocks ────────────────────────────────────────────

/**
 * Live block for the simulated deepThink — a "scratchpad" written by the
 * auxiliary cheap model BEFORE the main-model turn. Distinct from native
 * `thinking` (different model, different cost, different visual badge).
 * Lifecycle: created on `pre_think_started`, grows on each
 * `pre_think_delta`, sealed on `pre_think_completed` (status='done') or
 * `pre_think_failed` (status='failed' + error).
 */
export interface PreThinkStreamBlock {
  type: 'pre_think';
  text: string;
  model: string;
  provider: string;
  status: 'streaming' | 'done' | 'failed';
  error?: string;
}

export type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | PreThinkStreamBlock
  | { type: 'tool'; call: ToolCallEvent }
  | { type: 'plan'; plan: PlanPrompt }
  | { type: 'spec'; spec: SpecPrompt }
  | { type: 'question'; question: QuestionPrompt }
  | { type: 'tasks'; tasks: TasksPrompt }
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

/** Live context metrics emitted per-turn so the dashboard can show progress. */
export interface ContextStatus {
  history_chars: number;
  turn: number;
  max_turns: number;
  auto_continue_count: number;
  auto_continue_max: number;
  /** Actual input tokens for the most recent turn — represents real context window usage. */
  last_turn_input_tokens: number;
  /** Model context window size in tokens, or null when unknown. */
  context_window: number | null;
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
 * Bus event payload emitted whenever a loop-detection guard
 * (`dup-call-cap`, `doom-loop-strict`, `doom-loop-fuzzy`, `dominance`)
 * fires OR the dup-result marker triggers (informational — content was
 * prefixed but still delivered). Dashboard renders a banner so the user
 * sees the intervention live instead of having to scrape the server
 * log. Apêndice 3 — silent-failure work.
 *
 * Discriminated by `kind`: the four guard variants carry the full
 * count/threshold/snapshot shape; `dup-result-marker` carries only
 * the originalTurn/mode metadata (no snapshot — it's not a guard,
 * it's a content-delivery hint and `severity` is `'informational'`,
 * NOT a failure mode).
 */
export type ToolLoopIntervention =
  | (ToolLoopGuardIntervention & { receivedAt: number })
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
   *  fired). */
  snapshot: {
    strict: string[];
    fuzzy: string[];
    dominance: Array<{ name: string; hadText: boolean }>;
  };
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
  /** Last SSE event id seen for this session — used as Last-Event-ID on reattach. */
  lastSeenSeq: number;
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
   * Monotonic counter bumped on every `session_snapshot_changed` SSE event.
   * The Snapshots panel re-fetches its list/diff whenever this changes,
   * so the user sees new agent edits land in the review UI live.
   */
  snapshotTick: number;
  /**
   * Loop-detection interventions delivered by the bus during this run.
   * Newest first. Cap at 5 — older interventions are dropped to keep the
   * banner stack manageable. Cleared on next successful user message.
   */
  toolLoopInterventions: ToolLoopIntervention[];
  /**
   * Flat event log captured from the SSE stream — every event the
   * worker emits, in arrival order. Powers the WorkerLogPanel (a
   * collapsible side-by-side inspector). Capped at 1000 entries; older
   * entries are dropped LIFO so the most recent context survives.
   */
  eventLog: WorkerLogEntry[];
  /**
   * `Date.now()` of the last event observed on the stream. Used by the
   * stuck-detection banner — if `streaming` stays true but this stops
   * advancing for >30s the dashboard shows "Worker idle for Xs —
   * possible stall". Null until first event arrives.
   */
  lastEventAt: number | null;
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
  lastSeenSeq: -1,
  reattached: false,
  todos: [],
  contextStatus: null,
  indexStatus: null,
  interactionPending: null,
  pipelineRuntime: null,
  sidebarRefreshTick: 0,
  snapshotTick: 0,
  toolLoopInterventions: [],
  eventLog: [],
  lastEventAt: null,
};

export type SessionPatch =
  | Partial<SessionState>
  | ((s: SessionState) => Partial<SessionState>);

export type UpdateSession = (sid: number, patch: SessionPatch) => void;
