/**
 * Reducer for the multiplexed `agent_event` envelope.
 *
 * Each agent (master + every subordinate) emits its own inner events
 * (`text_delta`, `tool_call_start`, `tool_call_result`, `message_complete`,
 * `done`, `fallback_activated`). The stream slice routes them into the
 * right `AgentStreamState` and the global `fallbackNotices` ring.
 *
 * Replay safety: tool calls are deduped by `id`. `message_complete` clears
 * the text buffer so a replay doesn't double-render text already shown
 * in the rendered message.
 */
import type {
  AgentStreamState,
  AgentUsage,
  FallbackNotice,
  StreamState,
  ToolCallState,
} from '../types.js';
import type { StreamBlock } from '../../../hooks/agent-stream/types.js';
import {
  activityPatchFromOperation,
  activityPatchFromProviderCall,
  activityPatchFromToolProgress,
  finishActivity,
  upsertActivity,
  type ActivityPatch,
  type OperationPayload,
  type ProviderCallPayload,
  type ToolProgressPayload,
} from '../../../hooks/agent-stream/activity-blocks.js';

export interface AgentEventEnvelope {
  agent: string;
  agentRunId: string;
  event: string;
  data: unknown;
}

interface FallbackData {
  from?: { provider?: string; model?: string };
  to?: { provider?: string; model?: string };
  error?: string;
}

interface TextDeltaData { text: string }
interface ToolCallStartData { id: string; name: string }
interface ToolCallResultData {
  id: string;
  duration_ms?: number;
  status?: 'running' | 'done' | 'error';
  persistence?: 'pending';
}
interface GoalMutationsPersistedData { toolUseIds?: unknown }
interface GoalMutationsPersistenceFailedData {
  toolUseIds?: unknown;
  message?: unknown;
}
interface MessageCompleteData { usage?: AgentUsage }
interface DoneData { reason: string; error?: string }

export function applyAgentEvent(prev: StreamState, ae: AgentEventEnvelope): StreamState {
  if (ae.event === 'fallback_activated') {
    return appendFallbackNotice(prev, ae);
  }

  const isMaster = ae.agent === 'master';
  const current = isMaster
    ? prev.masterState
    : prev.subordinateStates.get(ae.agentRunId) ?? null;
  const seed: AgentStreamState = current ?? {
    role: ae.agent,
    agentRunId: ae.agentRunId,
    textChunks: [],
    toolCalls: [],
    status: 'running',
  };

  const next = reduceInner(seed, ae);
  if (next === seed) return prev;

  if (isMaster) return { ...prev, masterState: next };

  const subs = new Map(prev.subordinateStates);
  subs.set(ae.agentRunId, next);
  return { ...prev, subordinateStates: subs };
}

function reduceInner(state: AgentStreamState, ae: AgentEventEnvelope): AgentStreamState {
  switch (ae.event) {
    case 'text_delta':
      return appendTextDelta(state, ae.data as TextDeltaData);
    case 'tool_call_start': {
      const d = ae.data as ToolCallStartData;
      const withTool = startToolCall(state, d);
      return withActivityPatch(withTool, { id: d.id, kind: 'tool', label: d.name, status: 'running' });
    }
    case 'tool_call_result': {
      const d = ae.data as ToolCallResultData;
      const withTool = finishToolCall(state, d);
      const pending = d.persistence === 'pending' || d.status === 'running';
      return withActivityPatch(
        withTool,
        {
          id: d.id,
          status: pending ? 'running' : d.status === 'error' ? 'failed' : 'completed',
          elapsedMs: d.duration_ms,
          ...(pending ? { note: 'awaiting durable goal commit' } : {}),
        },
        !pending,
      );
    }
    case 'goal_mutations_persisted':
      return settleGoalMutations(
        state,
        goalMutationIds((ae.data as GoalMutationsPersistedData).toolUseIds),
      );
    case 'goal_mutations_persistence_failed': {
      const d = ae.data as GoalMutationsPersistenceFailedData;
      const message = typeof d.message === 'string' && d.message.length > 0
        ? d.message
        : 'Goal state could not be persisted.';
      return settleGoalMutations(state, goalMutationIds(d.toolUseIds), message);
    }
    case 'provider_call':
      return withActivityPatch(state, activityPatchFromProviderCall(ae.data as ProviderCallPayload));
    case 'tool_progress':
      return withActivityPatch(state, activityPatchFromToolProgress(ae.data as ToolProgressPayload));
    case 'operation_started':
    case 'operation_progress':
      return withActivityPatch(state, activityPatchFromOperation(ae.data as OperationPayload));
    case 'operation_finished':
      return withActivityPatch(state, activityPatchFromOperation(ae.data as OperationPayload), true);
    case 'message_complete':
      return clearActivity(completeMessage(state, ae.data as MessageCompleteData));
    case 'done':
      return clearActivity(markDone(state, ae.data as DoneData));
    default:
      return state;
  }
}

/**
 * Update the agent's single live activity by reusing the chat block helpers
 * over a 1-element scratch array. `upsertActivity` matches by id (so the same
 * provider/tool action is updated in place) or pushes a new one (latest action
 * wins) — we keep the last block as the current pill.
 */
function withActivityPatch(state: AgentStreamState, patch: ActivityPatch, finish = false): AgentStreamState {
  const arr: StreamBlock[] = state.activity ? [state.activity] : [];
  if (finish) finishActivity(arr, patch);
  else upsertActivity(arr, patch);
  const last = arr.length ? arr[arr.length - 1] : null;
  const activity = last && last.type === 'activity' ? last : state.activity ?? null;
  return { ...state, activity };
}

/** Drop the live pill between turns / on terminal states. */
function clearActivity(state: AgentStreamState): AgentStreamState {
  if (state.activity == null) return state;
  return { ...state, activity: null };
}

function appendTextDelta(state: AgentStreamState, d: TextDeltaData): AgentStreamState {
  if (!d.text) return state;
  return { ...state, textChunks: [...state.textChunks, d.text] };
}

function startToolCall(state: AgentStreamState, d: ToolCallStartData): AgentStreamState {
  // Dedup on replay so the same tool call doesn't appear twice.
  if (state.toolCalls.some((tc) => tc.id === d.id)) return state;
  const next: ToolCallState = { id: d.id, name: d.name, status: 'running' };
  return { ...state, toolCalls: [...state.toolCalls, next] };
}

function finishToolCall(state: AgentStreamState, d: ToolCallResultData): AgentStreamState {
  const pending = d.persistence === 'pending' || d.status === 'running';
  let changed = false;
  const next = state.toolCalls.map((tc) => {
    if (tc.id !== d.id) return tc;
    if (tc.status !== 'running') return tc;
    changed = true;
    return {
      ...tc,
      status: (pending ? 'running' : d.status === 'error' ? 'error' : 'done') as ToolCallState['status'],
      durationMs: d.duration_ms,
      awaitingPersistence: pending,
      error: undefined,
    };
  });
  return changed ? { ...state, toolCalls: next } : state;
}

function goalMutationIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

function settleGoalMutations(
  state: AgentStreamState,
  ids: string[],
  failure?: string,
): AgentStreamState {
  if (ids.length === 0) return state;
  const idSet = new Set(ids);
  let changed = false;
  const toolCalls = state.toolCalls.map((tool) => {
    if (!idSet.has(tool.id) || !tool.awaitingPersistence) return tool;
    changed = true;
    return {
      ...tool,
      status: (failure ? 'error' : 'done') as ToolCallState['status'],
      awaitingPersistence: false,
      error: failure,
    };
  });
  let next = changed
    ? {
        ...state,
        toolCalls,
        ...(failure ? { statusMessage: failure } : {}),
      }
    : state;
  for (const id of ids) {
    next = withActivityPatch(
      next,
      {
        id,
        status: failure ? 'failed' : 'completed',
        ...(failure ? { note: failure } : {}),
      },
      true,
    );
  }
  return next;
}

function completeMessage(state: AgentStreamState, d: MessageCompleteData): AgentStreamState {
  return { ...state, textChunks: [], usage: d.usage ?? state.usage };
}

function markDone(state: AgentStreamState, d: DoneData): AgentStreamState {
  return {
    ...state,
    status: d.reason === 'completed' ? 'completed' : 'error',
    doneReason: d.reason,
    statusMessage: d.error ?? state.statusMessage,
  };
}

function appendFallbackNotice(prev: StreamState, ae: AgentEventEnvelope): StreamState {
  const d = ae.data as FallbackData;
  const notice: FallbackNotice = {
    at: Date.now(),
    agent: ae.agent,
    from: d.from,
    to: d.to,
    error: d.error,
  };
  return {
    ...prev,
    fallbackNotices: [notice, ...prev.fallbackNotices].slice(0, 5),
  };
}
