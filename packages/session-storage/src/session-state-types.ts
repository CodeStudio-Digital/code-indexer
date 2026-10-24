export type {
  ExternalSessionSource,
  ExternalSessionCandidate,
  ExternalSessionPreview,
  ImportExternalSessionInput,
  ImportExternalSessionResult,
  PersistExternalSessionInput,
} from './external-session-types.js';

/** Provider-independent orchestration mode persisted in a session bundle. */
export type CoderExecutionMode = 'standard' | 'ultra';

export type SessionFilesystemAccess = 'read' | 'write';

/**
 * Aggregate metrics for a session. The filesystem repository rebuilds this
 * projection from immutable turn/provider-attempt records.
 */
export interface CoderSessionStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  last_turn_input_tokens: number;
  last_turn_prompt_tokens?: number | null;
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  duration_ms: number;
  context_window?: number | null;
}

export type CoderPlanStatus = 'pending' | 'approved' | 'rejected' | 'aborted';

/** Kinds of hidden input recorded under the owning session bundle. */
export type SessionInputKind =
  | 'system_prompt'
  | 'skill_content'
  | 'system_reminder'
  | 'subagent_prompt'
  | 'tools_snapshot'
  | 'phase_route_skip_summary'
  | 'preflight';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'interrupted';

/** Curated context the orchestrator pre-extracts and ships to a subagent. */
export type TaskReference =
  | { type: 'symbol'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'snippet'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'file'; value: string; file?: string; lines?: string; note?: string }
  | { type: 'doc'; value: string; file?: string; lines?: string; note?: string };

export type TaskKind = 'investigate' | 'implement' | 'verify';

/** A single executable unit persisted in the session's tasks projection. */
export interface CoderTask {
  id: string;
  title: string;
  description: string;
  agent_profile?: string;
  content?: string;
  activeForm?: string;
  files: string[];
  references: TaskReference[];
  depends_on: string[];
  suggested_mode: 'inline' | 'subagent';
  estimated_complexity: 'small' | 'medium' | 'large';
  parallel_group?: string;
  kind?: TaskKind;
  status: TaskStatus;
  mode_used?: 'inline' | 'subagent';
  /** Owning orchestrator run; never inferred from the most recent run. */
  task_run_id?: string;
  result?: TaskResult;
  started_at?: string;
  finished_at?: string;
  reject_reason?: string;
  force_run?: boolean;
}

export interface TaskResult {
  summary: string;
  files_modified: string[];
  subagent_usage?: Record<string, number | undefined>;
  errors?: string;
  sandbox_violations?: string[];
  effectOutcome?: 'unknown';
}

export type TaskExecutionMode = 'inline' | 'all-subagent' | 'smart' | 'per-task';

export type TaskGate = 'track' | 'approve';

/** Top-level task state stored as a versioned JSON entity in the bundle. */
export interface TasksState {
  gate?: TaskGate;
  summary: string;
  tasks: CoderTask[];
  execution_mode: TaskExecutionMode | null;
  approved: boolean;
  current_task_id: string | null;
}
