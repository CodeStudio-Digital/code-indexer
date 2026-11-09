/**
 * Reducer for `agent_status`, `subordinate_plan_posted`,
 * `subordinate_question_posted`, `subordinate_tasks_posted`, and
 * `session_idle` events.
 *
 * Status events update the relevant agent's `status` + `statusMessage`
 * without touching tool calls or text. `session_idle` rolls into the
 * master state with a synthetic status.
 */
import type { AgentRunStatus, CompanyAgentDispatchSource } from '@mcp/company-contracts';
import type { AgentStreamState, StreamState } from '../types.js';

export interface AgentStatusPayload {
  agentRunId: string;
  role: string;
  status: AgentRunStatus;
  message: string;
  /**
   * Coder session backing this agent run. The spawn `agent_status` carries
   * it so the dashboard can open the agent's transcript modal the moment it
   * spawns — before the REST snapshot is refreshed. Other emitters (e.g.
   * the runtime reconciler) omit it; the merge with persisted runs fills
   * the gap in that case.
   */
  coderSessionId?: string;
  configuredProvider?: string;
  configuredModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  dispatchSource?: CompanyAgentDispatchSource;
  fallbackReason?: string | null;
}

export function applyAgentStatus(prev: StreamState, d: AgentStatusPayload): StreamState {
  const isMaster = d.role === 'master';

  if (isMaster) {
    // Previously: only update when masterState existed. That made the
    // loader stall forever when the master finished before the UI had a
    // chance to subscribe to the event stream — `applySessionIdle` then
    // arrived but the `prev.masterState ? {...} : prev.masterState`
    // guard left the state null. Now we CREATE a minimal masterState
    // when none exists so subsequent status events can flow through and
    // CompanySessionView can derive a non-loader phase.
    if (prev.masterState) {
      return {
        ...prev,
        masterState: {
          ...prev.masterState,
          status: d.status,
          statusMessage: d.message,
          coderSessionId: prev.masterState.coderSessionId ?? d.coderSessionId,
          configuredProvider: d.configuredProvider ?? prev.masterState.configuredProvider,
          configuredModel: d.configuredModel ?? prev.masterState.configuredModel,
          effectiveProvider: d.effectiveProvider ?? prev.masterState.effectiveProvider,
          effectiveModel: d.effectiveModel ?? prev.masterState.effectiveModel,
          dispatchSource: d.dispatchSource ?? prev.masterState.dispatchSource,
          fallbackReason: d.fallbackReason ?? prev.masterState.fallbackReason,
        },
      };
    }
    return {
      ...prev,
      masterState: {
        role: 'master',
        agentRunId: d.agentRunId,
        coderSessionId: d.coderSessionId,
        toolCalls: [],
        status: d.status,
        statusMessage: d.message,
        configuredProvider: d.configuredProvider,
        configuredModel: d.configuredModel,
        effectiveProvider: d.effectiveProvider,
        effectiveModel: d.effectiveModel,
        dispatchSource: d.dispatchSource,
        fallbackReason: d.fallbackReason,
      },
    };
  }

  // Create-if-absent: the spawn `agent_status` is the FIRST signal for a
  // subordinate — it fires before the runner emits any `agent_event`. The
  // old code dropped it (`return prev`), so the agent only materialised
  // when it started streaming text, and without a `coderSessionId` (which
  // made its row a dead click). Now we seed the row here carrying the id;
  // a later `agent_event` reuses this state via `current ?? seed`.
  const subs = new Map(prev.subordinateStates);
  const existing = subs.get(d.agentRunId);
  if (existing) {
    subs.set(d.agentRunId, {
      ...existing,
      status: d.status,
      statusMessage: d.message,
      coderSessionId: existing.coderSessionId ?? d.coderSessionId,
      configuredProvider: d.configuredProvider ?? existing.configuredProvider,
      configuredModel: d.configuredModel ?? existing.configuredModel,
      effectiveProvider: d.effectiveProvider ?? existing.effectiveProvider,
      effectiveModel: d.effectiveModel ?? existing.effectiveModel,
      dispatchSource: d.dispatchSource ?? existing.dispatchSource,
      fallbackReason: d.fallbackReason ?? existing.fallbackReason,
    });
  } else {
    subs.set(d.agentRunId, {
      role: d.role,
      agentRunId: d.agentRunId,
      coderSessionId: d.coderSessionId,
      toolCalls: [],
      status: d.status,
      statusMessage: d.message,
      configuredProvider: d.configuredProvider,
      configuredModel: d.configuredModel,
      effectiveProvider: d.effectiveProvider,
      effectiveModel: d.effectiveModel,
      dispatchSource: d.dispatchSource,
      fallbackReason: d.fallbackReason,
    });
  }
  return { ...prev, subordinateStates: subs };
}

export function applySubordinateWaitingStatus(
  prev: StreamState,
  agentRunId: string,
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
  /** P15a — true when the runtime reports an abnormal exit. */
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
  const status = isError ? 'error' : 'waiting';
  const statusMessage =
    d.errorDetail ?? (isError ? 'Master failed' : 'Waiting for your input');
  return {
    ...prev,
    // Critical: when session_idle replays from the SSE buffer AFTER a
    // master that finished before the UI mounted, `prev.masterState`
    // can be null. Without creating a stub here, the "Iniciando
    // Master..." loader (conditioned on `!masterState`) would render
    // forever. The stub carries enough state for the phase indicator
    // to render the right pill; agentRunId/coderSessionId get filled
    // in lazily on the next real `agent_status` or via the REST
    // hydration from /state-snapshot.
    masterState: prev.masterState
      ? { ...prev.masterState, status, statusMessage }
      : {
          role: 'master',
          agentRunId: null,
          toolCalls: [],
          status,
          statusMessage,
        },
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
