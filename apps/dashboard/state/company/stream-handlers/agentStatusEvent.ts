/**
 * Reducer for `agent_status`, `subordinate_plan_posted`,
 * `subordinate_question_posted`, `subordinate_tasks_posted`, and
 * `session_idle` events.
 *
 * Status events update the relevant agent's `status` + `statusMessage`
 * without touching tool calls or text. `session_idle` rolls into the
 * master state with a synthetic status.
 */
import type { AgentRunStatus } from '@mcp/company-contracts';
import type { AgentStreamState, StreamState } from '../types.js';

export interface AgentStatusPayload {
  agentRunId: number;
  role: string;
  status: AgentRunStatus;
  message: string;
}

export function applyAgentStatus(prev: StreamState, d: AgentStatusPayload): StreamState {
  const isMaster = d.role === 'master';

  if (isMaster && prev.masterState) {
    return {
      ...prev,
      masterState: { ...prev.masterState, status: d.status, statusMessage: d.message },
    };
  }

  if (!prev.subordinateStates.has(d.agentRunId)) return prev;
  const subs = new Map(prev.subordinateStates);
  const existing = subs.get(d.agentRunId)!;
  subs.set(d.agentRunId, { ...existing, status: d.status, statusMessage: d.message });
  return { ...prev, subordinateStates: subs };
}

export function applySubordinateWaitingStatus(
  prev: StreamState,
  agentRunId: number,
  status: AgentStreamState['status'],
): StreamState {
  if (!prev.subordinateStates.has(agentRunId)) return prev;
  const subs = new Map(prev.subordinateStates);
  const existing = subs.get(agentRunId)!;
  subs.set(agentRunId, { ...existing, status });
  return { ...prev, subordinateStates: subs };
}

export interface SessionIdlePayload {
  reason?: string;
  errorDetail?: string;
}

export function applySessionIdle(prev: StreamState, d: SessionIdlePayload): StreamState {
  const isError = d.reason === 'master_error';
  return {
    ...prev,
    masterState: prev.masterState
      ? {
          ...prev.masterState,
          status: isError ? 'error' : 'waiting',
          statusMessage:
            d.errorDetail ?? (isError ? 'Master failed' : 'Waiting for your input'),
        }
      : prev.masterState,
    masterErrorDetail: isError ? (d.errorDetail ?? 'unknown') : null,
  };
}
