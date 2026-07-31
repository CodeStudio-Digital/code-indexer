import type {
  JsonValue,
  SessionState,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import {
  normalizeSessionMaxAutoContinues,
  normalizeSessionMaxTurns,
} from '../run-limits.js';
import type {
  FsPendingAgentTransition,
  FsRuntimeSessionState,
  FsToolOutputCapLevel,
  FsToolsetState,
} from './operational-types.js';

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

export function runtimeFromState(state: SessionState): FsRuntimeSessionState {
  const runtime = record(state.extra.runtime);
  return {
    max_turns: normalizeSessionMaxTurns(runtime.max_turns),
    max_auto_continues: normalizeSessionMaxAutoContinues(
      runtime.max_auto_continues,
    ),
    temperature_override:
      typeof runtime.temperature_override === 'number'
        ? runtime.temperature_override
        : null,
    reasoning_effort_override: nullableString(
      runtime.reasoning_effort_override,
    ),
    execution_mode_override:
      runtime.execution_mode_override === 'ultra' ? 'ultra' : 'standard',
    thinking_enabled: runtime.thinking_enabled === true,
    plan_depth_override: nullableString(runtime.plan_depth_override),
    response_language_override: nullableString(
      runtime.response_language_override,
    ),
    output_style_override: nullableString(runtime.output_style_override),
    preflight_seed_json: nullableString(runtime.preflight_seed_json),
    unrestricted_tool_output:
      typeof runtime.unrestricted_tool_output === 'boolean'
        ? runtime.unrestricted_tool_output
        : null,
    tool_output_cap_level: nullableString(
      runtime.tool_output_cap_level,
    ) as FsToolOutputCapLevel | null,
    last_response_id: nullableString(runtime.last_response_id),
    last_response_message_count: Number.isSafeInteger(
      runtime.last_response_message_count,
    )
      ? (runtime.last_response_message_count as number)
      : null,
    worktree_path: nullableString(runtime.worktree_path),
    fallback_provider: nullableString(runtime.fallback_provider),
    fallback_model: nullableString(runtime.fallback_model),
    cloudcode_session_id: nullableString(runtime.cloudcode_session_id),
    base_commit_sha: nullableString(runtime.base_commit_sha),
    last_review_at: nullableString(runtime.last_review_at),
    memory_distilled_seq: Number.isSafeInteger(runtime.memory_distilled_seq)
      ? Math.max(0, runtime.memory_distilled_seq as number)
      : 0,
    memory_distill_attempts: Number.isSafeInteger(
      runtime.memory_distill_attempts,
    )
      ? Math.max(0, runtime.memory_distill_attempts as number)
      : 0,
    pending_agent_transition:
      record(runtime.pending_agent_transition).id != null
        ? (runtime.pending_agent_transition as FsPendingAgentTransition)
        : null,
    config_lock:
      runtime.config_lock != null
        ? (toJsonValue(runtime.config_lock) as Readonly<
            Record<string, JsonValue>
          >)
        : null,
    group_id: nullableString(runtime.group_id),
  };
}

export function toolsetFromState(state: SessionState): FsToolsetState {
  const toolset = record(state.tools.toolset);
  return {
    v: 1,
    extraTiers: strings(toolset.extraTiers),
    pins: strings(toolset.pins),
    visibleCap:
      typeof toolset.visibleCap === 'number' ? toolset.visibleCap : null,
  };
}
