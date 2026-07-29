/**
 * Sibling/front-tab state per root session id.
 *
 * The root session owns one bundle, each front is a child, and `children`
 * reflects the live list ordered by creation time with UUID as a stable
 * tie-breaker.
 *
 * Reducers in this slice are pure — they accept loaded data and update
 * the map. REST calls live in `useCompanySiblings`, which dispatches
 * here after each successful network round-trip.
 */
import type { StateCreator } from 'zustand';
import type { CompanySession } from '@mcp/company-contracts';
import { INITIAL_SIBLING_STATE, type SiblingState } from './types.js';

export interface SessionSlice {
  /** Keyed by the root session UUID. */
  siblings: Map<string, SiblingState>;

  /** Ensure a slot exists for `rootId`; idempotent. */
  sessionEnsure: (rootId: string) => void;
  /** Replace parent + children after a `/children` REST call. */
  sessionLoaded: (rootId: string, parent: CompanySession, children: CompanySession[]) => void;
  /** Flip the loading flag (entry/exit of a refresh). */
  sessionSetLoading: (rootId: string, loading: boolean) => void;
  /** Set the active tab. Phase 1 will drive this from the URL. */
  sessionSetActive: (rootId: string, sessionId: string | null) => void;
  /** Upsert a child (after createChild or renameChild). */
  sessionUpsertChild: (rootId: string, child: CompanySession) => void;
  /** Remove a child (after archiveChild). */
  sessionRemoveChild: (rootId: string, childId: string) => void;
  /** Drop the slot entirely (e.g. session archived). */
  sessionReset: (rootId: string) => void;
}

function withSlot(
  prev: Map<string, SiblingState>,
  rootId: string,
  patch: (slot: SiblingState) => SiblingState,
): Map<string, SiblingState> {
  const next = new Map(prev);
  const current = next.get(rootId) ?? INITIAL_SIBLING_STATE;
  next.set(rootId, patch(current));
  return next;
}

function compareSessions(a: CompanySession, b: CompanySession): number {
  const byCreatedAt = a.created_at.localeCompare(b.created_at);
  return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
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
        const validIds = new Set<string>([parent.id, ...children.map((c) => c.id)]);
        const keepActive =
          slot.activeSessionId != null && validIds.has(slot.activeSessionId);
        return {
          parent,
          children: [...children].sort(compareSessions),
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
          children: [...withoutChild, child].sort(compareSessions),
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
