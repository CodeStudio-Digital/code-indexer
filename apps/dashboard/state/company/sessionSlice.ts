/**
 * Sibling/front-tab state per root session id.
 *
 * Mirrors `company_sessions.parent_session_id` (migration 067): the root
 * session owns one row, each front is a child, and `children` reflects
 * the live list of active sub-sessions ordered by id.
 *
 * Reducers in this slice are pure — they accept loaded data and update
 * the map. REST calls live in `useCompanySiblings`, which dispatches
 * here after each successful network round-trip.
 */
import type { StateCreator } from 'zustand';
import type { CompanySession } from '@mcp/company-contracts';
import { INITIAL_SIBLING_STATE, type SiblingState } from './types.js';

export interface SessionSlice {
  /** Keyed by ROOT session id (the parent in migration 067). */
  siblings: Map<number, SiblingState>;

  /** Ensure a slot exists for `rootId`; idempotent. */
  sessionEnsure: (rootId: number) => void;
  /** Replace parent + children after a `/children` REST call. */
  sessionLoaded: (rootId: number, parent: CompanySession, children: CompanySession[]) => void;
  /** Flip the loading flag (entry/exit of a refresh). */
  sessionSetLoading: (rootId: number, loading: boolean) => void;
  /** Set the active tab. Phase 1 will drive this from the URL. */
  sessionSetActive: (rootId: number, sessionId: number | null) => void;
  /** Upsert a child (after createChild or renameChild). */
  sessionUpsertChild: (rootId: number, child: CompanySession) => void;
  /** Remove a child (after archiveChild). */
  sessionRemoveChild: (rootId: number, childId: number) => void;
  /** Drop the slot entirely (e.g. session archived). */
  sessionReset: (rootId: number) => void;
}

function withSlot(
  prev: Map<number, SiblingState>,
  rootId: number,
  patch: (slot: SiblingState) => SiblingState,
): Map<number, SiblingState> {
  const next = new Map(prev);
  const current = next.get(rootId) ?? INITIAL_SIBLING_STATE;
  next.set(rootId, patch(current));
  return next;
}

export const createSessionSlice: StateCreator<SessionSlice, [], [], SessionSlice> = (set) => ({
  siblings: new Map(),

  sessionEnsure: (rootId) =>
    set((state) => {
      if (state.siblings.has(rootId)) return state;
      const next = new Map(state.siblings);
      next.set(rootId, INITIAL_SIBLING_STATE);
      return { siblings: next };
    }),

  sessionLoaded: (rootId, parent, children) =>
    set((state) => ({
      siblings: withSlot(state.siblings, rootId, (slot) => {
        const validIds = new Set<number>([parent.id, ...children.map((c) => c.id)]);
        const keepActive =
          slot.activeSessionId != null && validIds.has(slot.activeSessionId);
        return {
          parent,
          children: [...children].sort((a, b) => a.id - b.id),
          loading: false,
          activeSessionId: keepActive ? slot.activeSessionId : parent.id,
        };
      }),
    })),

  sessionSetLoading: (rootId, loading) =>
    set((state) => ({
      siblings: withSlot(state.siblings, rootId, (slot) => ({ ...slot, loading })),
    })),

  sessionSetActive: (rootId, sessionId) =>
    set((state) => ({
      siblings: withSlot(state.siblings, rootId, (slot) => ({
        ...slot,
        activeSessionId: sessionId,
      })),
    })),

  sessionUpsertChild: (rootId, child) =>
    set((state) => ({
      siblings: withSlot(state.siblings, rootId, (slot) => {
        const withoutChild = slot.children.filter((c) => c.id !== child.id);
        return {
          ...slot,
          children: [...withoutChild, child].sort((a, b) => a.id - b.id),
        };
      }),
    })),

  sessionRemoveChild: (rootId, childId) =>
    set((state) => ({
      siblings: withSlot(state.siblings, rootId, (slot) => {
        const children = slot.children.filter((c) => c.id !== childId);
        const activeStillValid =
          slot.activeSessionId != null &&
          [slot.parent?.id, ...children.map((c) => c.id)].includes(slot.activeSessionId);
        return {
          ...slot,
          children,
          activeSessionId: activeStillValid ? slot.activeSessionId : slot.parent?.id ?? null,
        };
      }),
    })),

  sessionReset: (rootId) =>
    set((state) => {
      if (!state.siblings.has(rootId)) return state;
      const next = new Map(state.siblings);
      next.delete(rootId);
      return { siblings: next };
    }),
});
