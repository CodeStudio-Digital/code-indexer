/**
 * Connection + agent + board + master-prompt state per company session.
 *
 * The slice owns the data; SSE transport stays in `useCompanyStream` for
 * now (Phase 0). Each SSE event delegates to a pure reducer in
 * `stream-handlers/` and the slice writes the resulting `StreamState`
 * back into the per-session slot.
 *
 * Replacing the inline `setState` calls in `useCompanyStream` with these
 * actions kills the duplicated kanban state path: kanban events go
 * through `kanbanSlice.kanbanApplyEvent` instead of being mirrored into
 * a second Map on the stream slice.
 */
import type { StateCreator } from 'zustand';
import type { MasterPrompt } from '@mcp/company-contracts';
import {
  INITIAL_STREAM_STATE,
  type BoardMessage,
  type StreamState,
} from './types.js';
import {
  applyAgentEvent,
  applyAgentStatus,
  applyBoardEntry,
  applyMasterPrompt,
  applySessionIdle,
  applySessionStalled,
  clearSessionStalled,
  applySubordinateWaitingStatus,
  hydrateMasterPrompts,
  type AgentEventEnvelope,
  type AgentStatusPayload,
  type SessionIdlePayload,
} from './stream-handlers/index.js';

export interface StreamSlice {
  streams: Map<number, StreamState>;

  // Lifecycle ───────────────────────────────────────────────
  streamEnsure: (sessionId: number) => void;
  streamReset: (sessionId: number) => void;
  streamSetConnected: (sessionId: number, connected: boolean) => void;
  streamSetStarted: (sessionId: number, started: boolean) => void;
  streamSetError: (sessionId: number, error: string | null) => void;
  streamSetUserMessage: (sessionId: number, msg: string | null) => void;
  /** P15d — record the latest SSE phase from the reconnecting client. */
  streamSetConnectionPhase: (
    sessionId: number,
    phase: StreamState['connectionPhase'],
  ) => void;

  // SSE event reducers ──────────────────────────────────────
  streamApplyAgentEvent: (sessionId: number, ev: AgentEventEnvelope) => void;
  streamApplyAgentStatus: (sessionId: number, payload: AgentStatusPayload) => void;
  streamApplySubordinateWaiting: (
    sessionId: number,
    agentRunId: number,
    status: 'waiting_plan' | 'waiting_question' | 'waiting_tasks',
  ) => void;
  streamApplyBoardEntry: (sessionId: number, entry: BoardMessage) => void;
  streamApplyMasterPrompt: (sessionId: number, prompt: MasterPrompt) => void;
  streamApplySessionIdle: (sessionId: number, payload: SessionIdlePayload) => void;
  /**
   * P15b — record that the session has stalled (no activity for >N min).
   * The dashboard renders a Continue banner with a manual nudge action.
   */
  streamApplySessionStalled: (sessionId: number, stalledSinceMs: number) => void;

  // REST hydration ──────────────────────────────────────────
  streamHydrateMasterPrompts: (sessionId: number, prompts: MasterPrompt[]) => void;
  streamHydrateFromInitialFetch: (sessionId: number, snapshot: InitialFetchSnapshot) => void;
}

export interface InitialFetchSnapshot {
  boardMessages?: BoardMessage[];
  masterState?: StreamState['masterState'];
  subordinateStates?: Map<number, StreamState['subordinateStates'] extends Map<number, infer T> ? T : never>;
  masterPrompts?: MasterPrompt[];
}

function withSlot(
  prev: Map<number, StreamState>,
  sessionId: number,
  patch: (slot: StreamState) => StreamState,
): Map<number, StreamState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_STREAM_STATE;
  next.set(sessionId, patch(current));
  return next;
}

export const createStreamSlice: StateCreator<StreamSlice, [], [], StreamSlice> = (set) => ({
  streams: new Map(),

  // ─── Lifecycle ──────────────────────────────────────────

  streamEnsure: (sessionId) =>
    set((state) => {
      if (state.streams.has(sessionId)) return state;
      const next = new Map(state.streams);
      next.set(sessionId, INITIAL_STREAM_STATE);
      return { streams: next };
    }),

  streamReset: (sessionId) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, () => INITIAL_STREAM_STATE),
    })),

  streamSetConnected: (sessionId, connected) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => ({ ...slot, connected })),
    })),

  streamSetStarted: (sessionId, started) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => ({ ...slot, started })),
    })),

  streamSetError: (sessionId, error) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => ({ ...slot, error })),
    })),

  streamSetUserMessage: (sessionId, userMessage) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => ({ ...slot, userMessage })),
    })),

  streamSetConnectionPhase: (sessionId, connectionPhase) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) =>
        slot.connectionPhase === connectionPhase ? slot : { ...slot, connectionPhase },
      ),
    })),

  // ─── SSE event reducers ─────────────────────────────────

  streamApplyAgentEvent: (sessionId, ev) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => applyAgentEvent(slot, ev)),
    })),

  streamApplyAgentStatus: (sessionId, payload) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => applyAgentStatus(slot, payload)),
    })),

  streamApplySubordinateWaiting: (sessionId, agentRunId, status) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) =>
        applySubordinateWaitingStatus(slot, agentRunId, status),
      ),
    })),

  streamApplyBoardEntry: (sessionId, entry) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => applyBoardEntry(slot, entry)),
    })),

  streamApplyMasterPrompt: (sessionId, prompt) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => applyMasterPrompt(slot, prompt)),
    })),

  streamApplySessionIdle: (sessionId, payload) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => applySessionIdle(slot, payload)),
    })),

  streamApplySessionStalled: (sessionId, stalledSinceMs) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) =>
        applySessionStalled(slot, stalledSinceMs),
      ),
    })),

  // ─── REST hydration ─────────────────────────────────────

  streamHydrateMasterPrompts: (sessionId, prompts) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) =>
        hydrateMasterPrompts(slot, prompts),
      ),
    })),

  streamHydrateFromInitialFetch: (sessionId, snapshot) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => {
        const next: StreamState = { ...slot, started: true };
        if (snapshot.boardMessages && snapshot.boardMessages.length > 0) {
          next.boardMessages = snapshot.boardMessages;
        }
        if (snapshot.masterState) {
          next.masterState = snapshot.masterState;
        }
        if (snapshot.subordinateStates && snapshot.subordinateStates.size > 0) {
          next.subordinateStates = snapshot.subordinateStates as StreamState['subordinateStates'];
        }
        if (snapshot.masterPrompts && snapshot.masterPrompts.length > 0) {
          return hydrateMasterPrompts(next, snapshot.masterPrompts);
        }
        return next;
      }),
    })),
});
