import type { AgentMessage } from '../core/messages.js';

export interface CoderSession {
  id: number;
  project_id: number;
  title: string;
  provider: string;
  model: string;
  status: 'idle' | 'running' | 'error';
  total_input_tokens: number;
  total_output_tokens: number;
  /** Cache-read tokens (cheaper, ~50% bill) accumulated across all turns. */
  total_cache_read_tokens: number;
  /** Cache-write tokens (Anthropic ephemeral) accumulated across all turns. */
  total_cache_creation_tokens: number;
  /** Optional group (folder) this session belongs to. */
  group_id: number | null;
  /** Archive flag — archived sessions are hidden from the default list. */
  is_archived: boolean;
  archived_at: string | null;
  /** Pin-to-top flag — favorited sessions sort above non-favorited. */
  is_favorite: boolean;
  favorited_at: string | null;
  /** Serialized lightweight todo list maintained by the `todo_write` tool. JSON string or null. */
  todos_json: string | null;
  /** Absolute path of the git worktree this session is scoped to (set by `enter_worktree`). */
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

/** Recent session enriched with project name for the global sidebar list. */
export interface RecentCoderSession extends CoderSession {
  project_name: string;
}

/** Per-project folder used to organize chat sessions in the sidebar. */
export interface CoderSessionGroup {
  id: number;
  project_id: number;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CoderMessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant' | 'tool';
  content_json: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  created_at: string;
}

/**
 * Aggregate metrics for a single session, computed in SQLite via a single
 * query (cheaper than recalculating in the front-end on every render).
 */
export interface CoderSessionStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  /** Wall-clock duration of the session, in ms (updated_at - created_at). */
  duration_ms: number;
}

export interface CoderToolCallRow {
  id: number;
  message_id: number;
  tool_use_id: string;
  tool_name: string;
  args_json: string;
  result_text: string | null;
  is_error: number;
  duration_ms: number;
  created_at: string;
}

export interface SessionWithMessages {
  session: CoderSession;
  messages: AgentMessage[];
  message_rows: CoderMessageRow[];
}

export type CoderPlanStatus = 'pending' | 'approved' | 'rejected' | 'aborted';

/**
 * One row per submit_plan call. Status starts as 'pending' and is updated
 * when the user responds (live or via the resume path after restart).
 */
export interface CoderPlanRow {
  id: number;
  session_id: number;
  tool_use_id: string;
  message_id: number | null;
  plan_text: string;
  status: CoderPlanStatus;
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ─── Tasks (migration 008) ─────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'interrupted';

/** Curated context the orchestrator pre-extracts and ships to a subagent. */
export type TaskReference =
  | { type: 'symbol'; value: string }
  | { type: 'snippet'; value: string }
  | { type: 'file'; value: string }
  | { type: 'doc'; value: string };

/** A single executable unit produced by submit_tasks and consumed by execute_task. */
export interface CoderTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  references: TaskReference[];
  depends_on: string[];
  suggested_mode: 'inline' | 'subagent';
  estimated_complexity: 'small' | 'medium' | 'large';
  // runtime state
  status: TaskStatus;
  mode_used?: 'inline' | 'subagent';
  result?: TaskResult;
  started_at?: string;
  finished_at?: string;
}

export interface TaskResult {
  summary: string;
  files_modified: string[];
  // ChatUsage from src/coder/core/messages.ts; left as Record to avoid circular import here.
  subagent_usage?: Record<string, number | undefined>;
  errors?: string;
  sandbox_violations?: string[];
}

export type TaskExecutionMode = 'inline' | 'all-subagent' | 'smart' | 'per-task';

/** Top-level shape persisted in coder_tasks_state.state JSON. */
export interface TasksState {
  /** 1-2 line statement of the overall objective from the model. */
  summary: string;
  tasks: CoderTask[];
  /** Set after user approval; null while awaiting verdict. */
  execution_mode: TaskExecutionMode | null;
  /** Whether the user has approved the list. */
  approved: boolean;
  /** Currently-running task id (for resume detection). */
  current_task_id: string | null;
}

export interface CoderTasksRow {
  session_id: number;
  tool_use_id: string;
  state: string; // JSON of TasksState
  version: number;
  created_at: string;
  updated_at: string;
}
