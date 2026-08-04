import type { SessionId } from '@mcp/session-storage';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

export interface SubagentRunData {
  session_id: SessionId;
  run_id: string;
  parent_run_id: string | null;
  parent_agent_run_id: string | null;
  spawn_id: string | null;
  profile: string;
  label: string | null;
  task_preview: string | null;
  requested_provider: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  wait_mode: 'foreground' | 'background';
  effective_provider: string | null;
  effective_model: string | null;
  effective_reasoning_effort: string | null;
  effective_capabilities: string[];
  environment_fingerprint: string | null;
  policy_mode: string | null;
  max_turns: number;
  max_tool_calls: number | null;
  timeout_ms: number | null;
  stall_ms: number | null;
  research_depth: string | null;
  soft_tool_target: number | null;
  soft_time_target_ms: number | null;
  status: 'running' | 'completed' | 'interrupted';
  reason: string | null;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  has_summary: boolean;
  output_id: string | null;
  synthesis_nudged: boolean;
  started_at: string;
  heartbeat_at: string;
  completed_at: string | null;
  worker_instance_id: string;
  fence_token: string;
}

export interface FsSubagentRunRow extends SubagentRunData {
  id: string;
  seq: number;
  revision: number;
}

export interface FsSubagentRunPage {
  items: FsSubagentRunRow[];
  totalCount: number;
  nextOffset: number | null;
  revision: number;
}

export interface SubagentToolCallData {
  session_id: SessionId;
  run_id: string;
  seq: number;
  turn: number | null;
  tool_name: string;
  logical_operation_id: string | null;
  productive: boolean;
  is_error: boolean;
  refusal_kind: string | null;
  duration_ms: number;
  result_chars: number;
  created_at: string;
}

export interface SubagentTranscriptData {
  session_id: SessionId;
  spawn_id: string;
  agent_index: number;
  messages: AgentMessage[];
}

export interface FsSubagentRunFence {
  session_id: SessionId;
  run_id: string;
  entity_id: string;
  fence_token: string;
}

export interface FsStartSubagentRunInput {
  session_id: SessionId;
  run_id: string;
  parent_run_id?: string | null;
  parent_agent_run_id?: string | null;
  spawn_id?: string | null;
  profile: string;
  label?: string | null;
  task_preview?: string | null;
  requested_provider?: string | null;
  requested_model?: string | null;
  requested_reasoning_effort?: string | null;
  wait_mode?: 'foreground' | 'background';
  effective_provider?: string | null;
  effective_model?: string | null;
  effective_reasoning_effort?: string | null;
  effective_capabilities?: string[];
  environment_fingerprint?: string | null;
  policy_mode?: string | null;
  max_turns: number;
  max_tool_calls?: number | null;
  timeout_ms?: number | null;
  stall_ms?: number | null;
  research_depth?: string | null;
  soft_tool_target?: number | null;
  soft_time_target_ms?: number | null;
}

export interface FsSubagentToolCallInput {
  session_id: SessionId;
  run_id: string;
  seq: number;
  turn?: number | null;
  tool_name: string;
  logical_operation_id?: string | null;
  productive?: boolean;
  is_error: boolean;
  refusal_kind?: string | null;
  duration_ms: number;
  result_chars: number;
  fence?: FsSubagentRunFence;
}

export interface FsCompleteSubagentRunInput {
  run_id: string;
  reason: string;
  turns: number;
  auto_continues: number;
  tool_calls: number;
  logical_operations: number;
  productive_operations: number;
  paginate_calls: number;
  duplicate_calls: number;
  error_calls: number;
  refused_calls: number;
  elapsed_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  has_summary: boolean;
  output_id?: string | null;
  synthesis_nudged?: boolean;
  fence: FsSubagentRunFence;
}

export interface FsWorkflowStepRunReconciliation {
  outcome: 'terminal' | 'outcome_unknown';
  runId?: string;
  stepStatus?: 'completed' | 'partial' | 'failed';
  reason?: string;
  resultRef?: string;
  hasSummary?: boolean;
  detail: string;
}
