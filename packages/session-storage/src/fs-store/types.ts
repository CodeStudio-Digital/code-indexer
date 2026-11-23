import type { AgentMessage } from '@mcp/provider-sdk';
import type { PromptContextMeasurement } from '@mcp/provider-sdk/prompt-cache-metrics.js';
import type {
  ArtifactInput,
  ArtifactRef,
  ChildAgentRelation,
  JsonValue,
  ProjectId,
  SessionId,
  SessionMetadata,
  SessionMetricsSummary,
  SessionState,
  SessionStorageScope,
  ToolOutputRecord,
} from '@mcp/session-storage';

export type FsCoderSessionStatus =
  | 'idle'
  | 'running'
  | 'error'
  | 'interrupted';

export interface FsLinkedProject {
  project_id: ProjectId;
  name: string;
  root_path: string;
  is_primary: boolean;
  label: string | null;
}

export interface FsLinkProjectInput {
  project_id: ProjectId;
  name: string;
  root_path: string;
  is_primary?: boolean;
  label?: string | null;
}

/**
 * Runtime/session DTO for the filesystem architecture. Its public identity is
 * always an opaque UUID; numeric IDs remain reserved for essential catalogs
 * such as projects.
 */
export interface FsCoderSession {
  id: SessionId;
  parent_session_id: SessionId | null;
  kind: string;
  storage_scope: SessionStorageScope;
  project_id: ProjectId | null;
  is_global: boolean;
  linked_projects: readonly FsLinkedProject[];
  import_source: 'claude-code' | 'codex' | null;
  import_external_id: string | null;
  import_fingerprint: string | null;
  import_source_updated_at: string | null;
  imported_at: string | null;
  title: string;
  provider: string;
  model: string;
  status: FsCoderSessionStatus;
  is_archived: boolean;
  archived_at: string | null;
  is_favorite: boolean;
  favorited_at: string | null;
  group_id: string | null;
  agent: string | null;
  todos_json: string | null;
  worktree_path: string | null;
  cloudcode_session_id: string | null;
  last_response_id: string | null;
  last_response_message_count: number | null;
  /** Null means this session runs until natural completion. */
  max_turns: number | null;
  max_auto_continues: number;
  temperature_override: number | null;
  reasoning_effort_override: string | null;
  execution_mode_override: 'standard' | 'ultra';
  thinking_enabled: boolean;
  block_code_comments: boolean;
  plan_depth_override: string | null;
  response_language_override: string | null;
  output_style_override: string | null;
  preflight_seed_json: string | null;
  unrestricted_tool_output: boolean | null;
  tool_output_cap_level:
    | 'economic'
    | 'medium'
    | 'high'
    | 'extra'
    | 'max'
    | 'ultra'
    | null;
  tool_permission_mode: 'ask' | 'auto' | 'unrestricted' | null;
  tool_permission_grants: string | null;
  tool_profile: 'bootstrap' | 'navigate' | 'full' | null;
  tool_state_json: string | null;
  summary_boundary_id: number | null;
  compaction_summary: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  last_turn_input_tokens: number;
  created_at: string;
  updated_at: string;
  metadata: SessionMetadata['metadata'];
  state: SessionState;
}

/** What the wait and cascade steps need about a child agent session. */
export interface FsChildAgentSession {
  id: SessionId;
  parent_session_id: SessionId;
  depth: number;
  status: FsCoderSessionStatus;
  is_archived: boolean;
  updated_at: string;
  /** Null only for a relation written without a child-agent state seed. */
  profile: string | null;
  read_only: boolean;
  /** Identifies the creation request, so a retried creation is idempotent. */
  creation_fingerprint: string | null;
  created_at: string;
  /** How its latest run ended; null until a run finished. */
  conclusion: FsChildAgentConclusion | null;
}

/**
 * The durable result of a child-agent run, written by the run itself when it
 * ends: a parent waiting again after a restart reads this instead of re-running.
 */
export interface FsChildAgentConclusion {
  run_id: string;
  state: 'completed' | 'failed' | 'cut_off' | 'aborted';
  reason: string;
  finished_at: string;
  /** The final answer (the salvage summary when cut off), bounded. */
  final_text: string | null;
  changed_files: string[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** What a child agent inherits and records at creation. */
export interface FsChildAgentStateSeed {
  profile: string;
  read_only: boolean;
  creation_fingerprint: string;
  permission_mode: 'ask' | 'auto' | 'unrestricted' | null;
  permission_grants: readonly string[];
  disabled_tools: readonly string[];
}

export interface FsGlobalCoderSession extends FsCoderSession {
  project_name: string;
  linked_count: number;
  workspace_label: string;
}

export interface FsProjectInfo {
  project_id: ProjectId;
  name: string;
  root_path: string;
}

export interface FsCreateSessionInput {
  /** Validated checkout selected when publishing the session. */
  worktree_path?: string | null;
  id?: SessionId;
  parent_session_id?: SessionId | null;
  /** Set only by the child-agent creation path. */
  agent_relation?: ChildAgentRelation;
  /** Child-agent creation only: state published together with the bundle. */
  child_agent_state?: FsChildAgentStateSeed;
  project_id: ProjectId;
  title: string;
  provider: string;
  model: string;
  agent?: string | null;
  status?: FsCoderSessionStatus;
  execution_mode_override?: 'standard' | 'ultra';
  reasoning_effort_override?: string | null;
  thinking_enabled?: boolean;
  block_code_comments?: boolean;
  max_turns?: number | null;
  max_auto_continues?: number;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface FsCreateGlobalSessionInput {
  id?: SessionId;
  parent_session_id?: SessionId | null;
  title: string;
  provider: string;
  model: string;
  agent?: string | null;
  status?: FsCoderSessionStatus;
  execution_mode_override?: 'standard' | 'ultra';
  reasoning_effort_override?: string | null;
  thinking_enabled?: boolean;
  block_code_comments?: boolean;
  max_turns?: number | null;
  max_auto_continues?: number;
  owner_project_id?: ProjectId | null;
  realProjects: ReadonlyArray<{
    projectId: ProjectId;
    rootPath?: string;
    isPrimary?: boolean;
    label?: string | null;
  }>;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface FsAppendMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface FsAppendMessageInput {
  session_id: SessionId;
  message: AgentMessage;
  usage?: FsAppendMessageUsage;
  operation_id?: string;
}

export interface FsToolCallInput {
  effect_outcome?: 'unknown';
  tool_use_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  result_text: string;
  raw_result?: string | Uint8Array;
  shaped_result?: string | Uint8Array;
  is_error: boolean;
  duration_ms: number;
  output_chars?: number;
  output_chars_shaped?: number | null;
  output_format?: 'text' | 'markdown' | 'json' | null;
  structured_output_chars?: number | null;
  truncated?: boolean;
  phase?: string | null;
  refusal_kind?: string | null;
  parent_tool_use_id?: string | null;
  reduction_kind?: string | null;
  reduction_technique?: string | null;
  reduction_meta_json?: string | null;
  output_id?: string | null;
  run_id?: string | null;
  parent_run_id?: string | null;
  is_subagent?: boolean;
  subagent_profile?: string | null;
  logical_operation_id?: string | null;
  productive?: boolean | null;
  guard_action?: 'allow' | 'reuse' | 'warn' | 'block' | 'shadow' | null;
  guard_reason?: string | null;
  would_block?: boolean | null;
  state_epoch?: number | null;
  result_novel?: boolean | null;
  coverage_novel?: boolean | null;
  delivered?: boolean | null;
  repeat_policy?: 'stable' | 'volatile' | 'pollable' | 'mutating' | null;
  execution_class?: 'read' | 'write' | 'execute' | 'control' | null;
  guard_origin_tool_use_id?: string | null;
  /** UUID of the immutable metrics/turns diagnostic record for this turn. */
  turn_telemetry_id?: string | null;
}

export interface FsPersistAssistantTurnInput {
  session_id: SessionId;
  message: AgentMessage;
  usage: FsAppendMessageUsage | null;
  context?: PromptContextMeasurement;
  tool_calls: readonly FsToolCallInput[];
  nested_tool_calls?: readonly FsToolCallInput[];
  subagent_usage?: FsAppendMessageUsage;
  /** The child-agent run keys `subagent_usage` covers: the durable "already counted" mark. */
  subagent_runs?: readonly string[];
  existing_message_seq?: number;
  operation_id?: string;
}

export interface FsAppendToolCallInput extends FsToolCallInput {
  session_id: SessionId;
  message_seq: number;
  operation_id?: string;
}

export interface FsCoderMessageRow {
  /** Stable record identity. Ordering and pagination use `seq`, never this UUID. */
  id: string;
  seq: number;
  session_id: SessionId;
  turn_seq: number;
  operation_id: string;
  role: AgentMessage['role'];
  /** Additive public assistant phase; absent on legacy/test row fixtures. */
  phase?: AgentMessage['phase'] | null;
  content_json: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  created_at: string;
  is_meta: 0 | 1;
  selected_skill_ids_json: string | null;
  artifact_refs: readonly ArtifactRef[];
}

export interface FsSessionWithMessages {
  /** Typed host evidence from the full projected history, including compacted rows. */
  unresolved_tool_outcomes?: string[];
  resolved_tool_outcomes?: string[];
  tool_outcome_state?: import('./tool-outcome-types.js').FsToolOutcomeState;
  session: FsCoderSession;
  messages: AgentMessage[];
  message_rows: FsCoderMessageRow[];
}

export interface FsMessagePage {
  messages: AgentMessage[];
  message_rows: FsCoderMessageRow[];
  next_cursor: number | null;
}

export interface FsToolCallRecord {
  schema_version: 1;
  id: string;
  message_seq: number;
  tool_use_id: string;
  tool_name: string;
  args: JsonValue;
  is_error: boolean;
  duration_ms: number;
  nested: boolean;
  output: ToolOutputRecord;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface FsToolCallResult {
  id: string;
  session_id: SessionId;
  message_seq: number;
  tool_use_id: string;
  tool_name: string;
  result_text: string;
  raw_result_text: string | null;
  is_error: boolean;
  duration_ms: number;
  output: ToolOutputRecord;
}

export interface FsToolOutputRead {
  record: ToolOutputRecord;
  raw: Uint8Array | null;
  shaped: Uint8Array | null;
}

export interface FsStoredMessage {
  schema_version: 1;
  id: string;
  seq: number;
  role: AgentMessage['role'];
  phase?: AgentMessage['phase'];
  provider_replay?: AgentMessage['providerReplay'];
  content: JsonValue;
  usage: {
    context?: PromptContextMeasurement;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  is_meta: boolean;
  selected_skill_ids: readonly string[];
  artifact_refs: readonly ArtifactRef[];
}

export interface FsStoredMessagePatch {
  seq: number;
  content?: JsonValue;
  usage?: FsStoredMessage['usage'];
  artifact_refs?: readonly ArtifactRef[];
}

export interface FsCoderTurnPayload {
  schema_version: 1;
  type: 'coder.turn';
  request_key: string;
  /**
   * Append-only rollback marker. Projection hides this message sequence and
   * every later message/tool call from the active transcript. The journal retains them.
   */
  truncate_from_seq?: number;
  messages: readonly FsStoredMessage[];
  message_patches: readonly FsStoredMessagePatch[];
  tool_calls: readonly FsToolCallRecord[];
  tool_outcome_resolutions?: readonly import('./tool-outcome-types.js').FsToolOutcomeResolutionRecord[];
  tool_outcome_incidents?: readonly import('./tool-outcome-types.js').FsToolOutcomeIncidentRecord[];
  /** Legacy journal field; retained for reading historical transcripts, never executed. */
  goal_mutations?: readonly JsonValue[];
}

export interface FsPreparedMessage {
  stored: Omit<FsStoredMessage, 'id' | 'seq'>;
  artifacts: readonly ArtifactInput[];
}

export type FsMetricsSummary = SessionMetricsSummary;
