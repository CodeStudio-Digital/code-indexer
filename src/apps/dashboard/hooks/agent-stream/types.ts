export interface ToolCallEvent {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  durationMs?: number;
  status: 'running' | 'done' | 'error';
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

export type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; call: ToolCallEvent }
  | { type: 'plan'; plan: PlanPrompt }
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
};

export type SessionPatch =
  | Partial<SessionState>
  | ((s: SessionState) => Partial<SessionState>);

export type UpdateSession = (sid: number, patch: SessionPatch) => void;
