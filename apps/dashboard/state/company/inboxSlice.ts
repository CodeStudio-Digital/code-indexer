/**
 * Agent inbox state per session.
 *
 * The backend already emits five inbox events through MetaBus:
 * `inbox_message_sent`, `inbox_message_delivered`,
 * `inbox_message_answered`, `inbox_message_cancelled`,
 * `inbox_message_expired`. Their payloads are deliberately thin (id +
 * routing) so they can't fully reconstruct the row client-side.
 *
 * Strategy: keep the message list authoritatively in the slice via
 * `hydrate` (REST), and use `lastEventSeq` as a monotonic counter the
 * panel watches with `useEffect` to know when to refetch. Phase 4 will
 * fatten the payloads (full row) so the slice can update incrementally
 * without round-trips, but for now the SSE event → REST refetch handshake
 * is the smallest change that kills the 5 s polling.
 */
import type { StateCreator } from 'zustand';
import type { AgentInboxMessage } from '@mcp/company-contracts';

export interface InboxState {
  messagesById: Map<number, AgentInboxMessage>;
  /** Monotonic counter — increments on every inbox SSE event. */
  lastEventSeq: number;
  initialized: boolean;
  loading: boolean;
  error: string | null;
}

export const INITIAL_INBOX_STATE: InboxState = {
  messagesById: new Map(),
  lastEventSeq: 0,
  initialized: false,
  loading: false,
  error: null,
};

export interface InboxSlice {
  inbox: Map<number, InboxState>;
  inboxEnsure: (sessionId: number) => void;
  inboxSetLoading: (sessionId: number, loading: boolean) => void;
  inboxSetError: (sessionId: number, error: string | null) => void;
  /** Replace the full message map (initial REST fetch). */
  inboxHydrate: (sessionId: number, messages: AgentInboxMessage[]) => void;
  /** Bump `lastEventSeq` so any consumer watching it triggers a refetch. */
  inboxBumpEventSeq: (sessionId: number) => void;
  inboxReset: (sessionId: number) => void;
}

function withSlot(
  prev: Map<number, InboxState>,
  sessionId: number,
  patch: (slot: InboxState) => InboxState,
): Map<number, InboxState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_INBOX_STATE;
  next.set(sessionId, patch(current));
  return next;
}

export const createInboxSlice: StateCreator<InboxSlice, [], [], InboxSlice> = (set) => ({
  inbox: new Map(),

  inboxEnsure: (sessionId) =>
    set((state) => {
      if (state.inbox.has(sessionId)) return state;
      const next = new Map(state.inbox);
      next.set(sessionId, INITIAL_INBOX_STATE);
      return { inbox: next };
    }),

  inboxSetLoading: (sessionId, loading) =>
    set((state) => ({
      inbox: withSlot(state.inbox, sessionId, (slot) => ({ ...slot, loading })),
    })),

  inboxSetError: (sessionId, error) =>
    set((state) => ({
      inbox: withSlot(state.inbox, sessionId, (slot) => ({ ...slot, error })),
    })),

  inboxHydrate: (sessionId, messages) =>
    set((state) => ({
      inbox: withSlot(state.inbox, sessionId, (slot) => ({
        ...slot,
        messagesById: new Map(messages.map((m) => [m.id, m])),
        initialized: true,
        error: null,
      })),
    })),

  inboxBumpEventSeq: (sessionId) =>
    set((state) => ({
      inbox: withSlot(state.inbox, sessionId, (slot) => ({
        ...slot,
        lastEventSeq: slot.lastEventSeq + 1,
      })),
    })),

  inboxReset: (sessionId) =>
    set((state) => {
      if (!state.inbox.has(sessionId)) return state;
      const next = new Map(state.inbox);
      next.delete(sessionId);
      return { inbox: next };
    }),
});
