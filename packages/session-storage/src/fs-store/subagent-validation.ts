import {
  asAgentRunId,
  isUuid,
  type JsonValue,
} from '@mcp/session-storage';
import type { FsEntityEnvelope } from './entity-files.js';
import type {
  FsSubagentRunFence,
  SubagentRunData,
} from './subagent-types.js';

const PARTIAL_REASONS = new Set([
  'max_turns',
  'tool_budget',
  'time_budget',
]);

export function workflowStepStatus(
  reason: string,
): 'completed' | 'partial' | 'failed' {
  if (reason === 'completed') return 'completed';
  return PARTIAL_REASONS.has(reason) ? 'partial' : 'failed';
}

export function validatedUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

export function optionalAgentRunId(
  value: string | null | undefined,
) {
  return value == null ? null : asAgentRunId(value);
}

export function validatedRunData(
  item: FsEntityEnvelope<JsonValue>,
): SubagentRunData {
  const data = item.data as unknown as SubagentRunData;
  return {
    ...data,
    run_id: asAgentRunId(data.run_id),
    parent_run_id: optionalAgentRunId(data.parent_run_id),
    parent_agent_run_id: optionalAgentRunId(data.parent_agent_run_id),
    fence_token: validatedUuid(
      data.fence_token,
      'subagent fence_token',
    ),
  };
}

export function validatedFence(
  fence: FsSubagentRunFence,
): FsSubagentRunFence {
  return {
    ...fence,
    run_id: asAgentRunId(fence.run_id),
    entity_id: validatedUuid(
      fence.entity_id,
      'subagent fence entity_id',
    ),
    fence_token: validatedUuid(
      fence.fence_token,
      'subagent fence_token',
    ),
  };
}
