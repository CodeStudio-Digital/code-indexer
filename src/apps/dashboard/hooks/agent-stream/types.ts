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
  references?: Array<{ type: string; value: string }>;
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

export type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallEvent }
  | { type: 'plan'; plan: PlanPrompt }
  | { type: 'question'; question: QuestionPrompt }
  | { type: 'tasks'; tasks: TasksPrompt };

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
};

export type SessionPatch =
  | Partial<SessionState>
  | ((s: SessionState) => Partial<SessionState>);

export type UpdateSession = (sid: number, patch: SessionPatch) => void;
