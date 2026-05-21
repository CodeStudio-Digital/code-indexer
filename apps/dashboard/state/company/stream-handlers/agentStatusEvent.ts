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
  /** P15a — ISO timestamp of when the master's runner exited. */
  endedAt?: string;
  /** P15a — true when the exit looked unexpected (error or no recent user msg). */
  unexpected?: boolean;
}

/**
 * Reducer for the P15b `session_stalled` event. Stores the
 * "stalled since" delta so the dashboard banner can show "Sessão parada
 * há 6 min". `null` clears the stall.
 */
export function applySessionStalled(prev: StreamState, stalledSinceMs: number): StreamState {
  return { ...prev, sessionStalledSinceMs: stalledSinceMs };
}

export function clearSessionStalled(prev: StreamState): StreamState {
  if (prev.sessionStalledSinceMs == null) return prev;
  return { ...prev, sessionStalledSinceMs: null };
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
    // P15a — these fields drive the "Master finished/ended" banner.
    // The reducer keeps prior values when the event carries no `endedAt`
    // (e.g. legacy `session_idle` from a server that pre-dates this
    // payload extension); a fresh `endedAt` always wins.
    masterEndedAt: d.endedAt ?? prev.masterEndedAt,
    masterEndedUnexpected:
      d.endedAt !== undefined ? !!d.unexpected : prev.masterEndedUnexpected,
  };
}
