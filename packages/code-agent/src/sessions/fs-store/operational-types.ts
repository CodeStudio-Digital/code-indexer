import type {
  CoderExecutionMode,
  CoderTask,
  CoderPlanStatus,
  SessionInputKind,
  TaskExecutionMode,
  TaskKind,
  TaskStatus,
  TasksState,
} from '@mcp/code-agent/sessions/types.js';
import type {
  JsonValue,
  ProjectId,
  SessionId,
} from '@mcp/session-storage';

export type FsToolOutputCapLevel =
  | 'economic'
  | 'medium'
  | 'high'
  | 'extra'
  | 'max'
  | 'ultra';

export interface FsToolsetState {
  v: 1;
  extraTiers: string[];
  pins: string[];
  visibleCap: number | null;
}

export interface FsPendingAgentTransition {
  id: string;
  sessionId: SessionId;
  fromAgent: string | null;
  toAgent: string | null;
  seq: number;
  updatedAt: string;
}

export interface FsRuntimeSessionState {
  temperature_override: number | null;
  reasoning_effort_override: string | null;
  execution_mode_override: CoderExecutionMode;
  thinking_enabled: boolean;
  plan_depth_override: string | null;
  response_language_override: string | null;
  output_style_override: string | null;
  preflight_seed_json: string | null;
  unrestricted_tool_output: boolean | null;
  tool_output_cap_level: FsToolOutputCapLevel | null;
  last_response_id: string | null;
  last_response_message_count: number | null;
  worktree_path: string | null;
  fallback_provider: string | null;
  fallback_model: string | null;
  cloudcode_session_id: string | null;
  base_commit_sha: string | null;
  last_review_at: string | null;
  memory_distilled_seq: number;
  memory_distill_attempts: number;
  pending_agent_transition: FsPendingAgentTransition | null;
  config_lock: Readonly<Record<string, JsonValue>> | null;
  group_id: string | null;
}

export interface FsSessionGroup {
  id: string;
  seq: number;
  project_id: ProjectId | null;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FsSessionFilesystemRoot {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  root_path: string;
  access: 'read' | 'write';
  created_at: string;
  updated_at: string;
}

export type FsGoalStatus = 'in_progress' | 'complete' | 'superseded';

export interface FsGoalSnapshot {
  id: string;
  text: string;
  status: FsGoalStatus;
  budget_tokens: number | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FsGoalMutation {
  id: string;
  seq: number;
  source: 'tool' | 'admin';
  tool_use_id: string | null;
  tool_name: 'create_goal' | 'update_goal' | null;
  expected: FsGoalSnapshot | null;
  next: FsGoalSnapshot | null;
}

export interface FsSessionGoal extends FsGoalSnapshot {
  revision: number;
  mutation_seq: number;
}

export interface FsUpsertGoalInput {
  text: string;
  status: FsGoalStatus;
  budgetTokens?: number | null;
  completionNote?: string | null;
  createdAt: string;
  updatedAt: string;
  expected_revision?: number;
  operation_id?: string;
}

export interface FsPlanRow {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  tool_use_id: string;
  message_seq: number | null;
  plan_text: string;
  status: CoderPlanStatus;
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface FsRecordPlanInput {
  session_id: SessionId;
  tool_use_id: string;
  plan_text: string;
  message_seq?: number | null;
  operation_id?: string;
}

export interface FsSessionInputRow {
  id: string;
  seq: number;
  session_id: SessionId;
  kind: SessionInputKind;
  source_label: string;
  content: string;
  content_hash: string;
  meta: Readonly<Record<string, JsonValue>> | null;
  created_at: string;
}

export interface FsRecordSessionInput {
  session_id: SessionId;
  kind: SessionInputKind;
  source_label: string;
  content: string;
  meta?: Record<string, unknown> | null;
  operation_id?: string;
}

export interface FsSessionMemoryRow {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  kind: string;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface FsRememberInput {
  title: string;
  body: string;
  kind?: string;
  pinned?: boolean;
  operation_id?: string;
}

export interface FsInvestigationRow {
  id: string;
  seq: number;
  project_id: ProjectId | null;
  session_id: SessionId;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
  created_at: string;
}

export interface FsRecordInvestigationInput {
  session_id: SessionId;
  topic: string;
  summary: string;
  body?: string;
  source_label?: string | null;
  agent_type?: string | null;
  tokens?: number;
  operation_id?: string;
}

export interface FsDriveAggregate {
  memory: FsSessionMemoryRow[];
  investigations: FsInvestigationRow[];
  fileMap: { read: string[]; changed: string[] };
  plans: FsPlanRow[];
  tasks: TasksState | null;
}

export interface FsDriveInjectionPayload {
  activePlan: { text: string; status: string } | null;
  sessionMemory: Array<{ id: string; title: string; body: string }>;
  investigationCount: number;
}

export interface FsSessionStateData {
  goal: { text: string; status: string } | null;
  activePlan: { text: string; status: string } | null;
  todos: Array<{ status: string; label: string }>;
  notes: Array<{
    id: string;
    title: string;
    body: string;
    kind: string;
    pinned: boolean;
  }>;
  filesChanged: string[];
  investigationCount: number;
}

export interface FsTasksRow {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  tool_use_id: string;
  state: TasksState;
  created_at: string;
  updated_at: string;
}

export interface FsRecordTasksInput {
  session_id: SessionId;
  tool_use_id: string;
  state: TasksState;
  operation_id?: string;
}

export type FsTaskRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface FsTaskRunRow {
  id: string;
  seq: number;
  revision: number;
  run_id: string;
  session_id: SessionId;
  mode: 'auto' | 'inline-all';
  started_at: string;
  finished_at: string | null;
  status: FsTaskRunStatus;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  budget_tokens: number | null;
  budget_usd_cents: number | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface FsCreateTaskRunInput {
  run_id: string;
  session_id: SessionId;
  mode: 'auto' | 'inline-all';
  started_at: string;
  budget_tokens?: number | null;
  budget_usd_cents?: number | null;
  operation_id?: string;
}

export interface FsUpdateTaskRunPatch {
  status?: FsTaskRunStatus;
  finished_at?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_creation_tokens?: number;
  reject_reason?: string | null;
  operation_id?: string;
}

export interface FsTaskRunItemRow {
  id: string;
  seq: number;
  revision: number;
  run_id: string;
  task_id: string;
  attempt: number;
  wave_idx: number;
  parallel_group: string | null;
  kind: TaskKind;
  title: string;
  started_at: string | null;
  finished_at: string | null;
  status: TaskStatus;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  inputs_fingerprint: string | null;
  skip_reason: string | null;
  error: string | null;
  summary: string | null;
}

export interface FsUpsertTaskRunItemInput
  extends Omit<
    FsTaskRunItemRow,
    'id' | 'seq' | 'revision' | 'attempt'
  > {
  attempt?: number;
  session_id: SessionId;
  operation_id?: string;
}

export interface FsToolCallStats {
  totalCalls: number;
  directCalls: number;
  nestedCalls: number;
  guardOutcomes: {
    genuineErrors: number;
    rootRefusals: number;
    propagatedParentFailures: number;
    reusedCalls: number;
    shadowCandidates: number;
  };
  byName: Array<{
    name: string;
    count: number;
    errorCount: number;
    refusedCount: number;
    propagatedFailureCount: number;
    reuseCount: number;
    shadowCount: number;
    lastAt: string | null;
  }>;
  recent: Array<{
    id: string;
    seq: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
    outcome:
      | 'success'
      | 'genuine_error'
      | 'root_refusal'
      | 'propagated_parent_failure'
      | 'reuse'
      | 'shadow';
    guardAction: string | null;
    guardReason: string | null;
  }>;
  savings: {
    totalRawChars: number;
    totalShapedChars: number;
    totalSavedChars: number;
    totalSavedTokensEst: number;
    byTool: Array<{
      name: string;
      rawChars: number;
      shapedChars: number;
      savedChars: number;
    }>;
    semanticSavedChars: number;
    jsonCrushSavedChars: number;
    hardCapSavedChars: number;
    nestedRawChars: number;
    byTechnique: Array<{
      kind: string;
      technique: string;
      calls: number;
      rawChars: number;
      shapedChars: number;
      savedChars: number;
    }>;
  };
}

export interface FsSessionEvent {
  id: string;
  seq: number;
  type: string;
  created_at: string;
  payload: JsonValue;
}

export type {
  CoderExecutionMode,
  CoderPlanStatus,
  CoderTask,
  SessionInputKind,
  TaskExecutionMode,
  TaskKind,
  TaskStatus,
  TasksState,
};
