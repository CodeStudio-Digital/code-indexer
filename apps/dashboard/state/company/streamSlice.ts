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
  streams: Map<string, StreamState>;

  // Lifecycle ───────────────────────────────────────────────
  streamEnsure: (sessionId: string) => void;
  streamReset: (sessionId: string) => void;
  streamSetConnected: (sessionId: string, connected: boolean) => void;
  streamSetStarted: (sessionId: string, started: boolean) => void;
  streamSetError: (sessionId: string, error: string | null) => void;
  streamSetUserMessage: (sessionId: string, msg: string | null) => void;
  /** P15d — record the latest SSE phase from the reconnecting client. */
  streamSetConnectionPhase: (
    sessionId: string,
    phase: StreamState['connectionPhase'],
  ) => void;

  // SSE event reducers ──────────────────────────────────────
  streamApplyAgentEvent: (sessionId: string, ev: AgentEventEnvelope) => void;
  streamApplyAgentStatus: (sessionId: string, payload: AgentStatusPayload) => void;
  streamApplySubordinateWaiting: (
    sessionId: string,
    agentRunId: string,
    status: 'waiting_plan' | 'waiting_question' | 'waiting_tasks',
  ) => void;
  /** Drop a subordinate from the live map (after the user deletes it). */
  streamRemoveSubordinate: (sessionId: string, agentRunId: string) => void;
  streamApplyBoardEntry: (sessionId: string, entry: BoardMessage) => void;
  streamApplyMasterPrompt: (sessionId: string, prompt: MasterPrompt) => void;
  streamApplySessionIdle: (sessionId: string, payload: SessionIdlePayload) => void;
  /**
   * P15b — record that the session has stalled (no activity for >N min).
   * The dashboard renders a Continue banner with a manual nudge action.
   */
  streamApplySessionStalled: (sessionId: string, stalledSinceMs: number) => void;

  // REST hydration ──────────────────────────────────────────
  streamHydrateMasterPrompts: (sessionId: string, prompts: MasterPrompt[]) => void;
  streamHydrateFromInitialFetch: (sessionId: string, snapshot: InitialFetchSnapshot) => void;
}

export interface InitialFetchSnapshot {
  boardMessages?: BoardMessage[];
  masterState?: StreamState['masterState'];
  subordinateStates?: Map<string, StreamState['subordinateStates'] extends Map<string, infer T> ? T : never>;
  masterPrompts?: MasterPrompt[];
}

function withSlot(
  prev: Map<string, StreamState>,
  sessionId: string,
  patch: (slot: StreamState) => StreamState,
): Map<string, StreamState> {
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
      // Live agent activity means the session is no longer stalled — clear
      // the stall banner so it doesn't linger after work resumes (the
      // backend watchdog only emits `session_stalled`, never an "un-stall").
      streams: withSlot(state.streams, sessionId, (slot) =>
        clearSessionStalled(applyAgentEvent(slot, ev)),
      ),
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

  streamRemoveSubordinate: (sessionId, agentRunId) =>
    set((state) => ({
      streams: withSlot(state.streams, sessionId, (slot) => {
        if (!slot.subordinateStates.has(agentRunId)) return slot;
        const subs = new Map(slot.subordinateStates);
        subs.delete(agentRunId);
        const agentTextPreviews = new Map(slot.agentTextPreviews);
        agentTextPreviews.delete(agentRunId);
        return { ...slot, subordinateStates: subs, agentTextPreviews };
      }),
    })),

  streamApplyBoardEntry: (sessionId, entry) =>
    set((state) => ({
      // A new board post is activity too — clear any stall banner.
      streams: withSlot(state.streams, sessionId, (slot) =>
        clearSessionStalled(applyBoardEntry(slot, entry)),
      ),
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
        // Don't force started:true here — the caller decides. When the
        // reattach pre-flight saw masterAlive=false it explicitly sets
        // started=false right before this call; forcing true would
        // resurrect the "Iniciando Master..." loader for paused/idle
        // sessions even when there's no live runner to wait for.
        const next: StreamState = { ...slot };
        if (snapshot.boardMessages && snapshot.boardMessages.length > 0) {
          next.boardMessages = snapshot.boardMessages;
        }
        // Always copy masterState — including null. If the backend
        // says there's no master agent_run yet (e.g., a fresh sub-
        // session), we want the slot to mirror that, not retain a
        // stale instance from a previous mount.
        next.masterState = snapshot.masterState ?? null;
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
