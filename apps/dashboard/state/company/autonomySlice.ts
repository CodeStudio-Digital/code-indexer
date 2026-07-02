/**
 * C1 — organism-visibility state per company session.
 *
 * Holds a bounded ring (~100 items) of `AutonomyEvent`s (scheduler
 * dispatches/skips, auto-approvals, supervisor incidents, master nudges)
 * plus the last-known effective autonomy config. Live events arrive via
 * the SSE stream (`stream-handlers/autonomyEvent.ts`); the initial seed
 * comes from `GET /api/company/sessions/:id/autonomy` (AutonomyPanel).
 *
 * Every field of the payload is optional/defensive — the dashboard never
 * goes through tsc, so a missing field must degrade to "not shown", not
 * to a crash.
 */
import type { StateCreator } from 'zustand';

export type AutonomyEventType = 'dispatch' | 'approval' | 'incident' | 'nudge' | 'skip';

export interface AutonomyEvent {
  /** Client-local unique id (SSE events carry no stable id). */
  id: string;
  atMs: number;
  type: AutonomyEventType;
  /** Original wire event name (e.g. 'scheduler_sweep') or REST source tag. */
  event?: string;
  role?: string;
  agentRunId?: number;
  cardId?: number;
  /** Incident kind / nudge case. */
  kind?: string;
  /** Skip reason ('no_role' | 'recommend_failed' | 'spawn_failed'). */
  reason?: string;
  /** Free text (incident detail, board post content). */
  detail?: string;
  /** scheduler_sweep only. */
  dispatched?: number;
  freeSlots?: number;
}

/** Defensive mirror of the server-side AutonomyConfig — every key optional. */
export interface AutonomyConfigLike {
  scheduler?: boolean;
  orphanReset?: boolean;
  autoApproveRoles?: string[] | '*' | null;
  supervisorMaster?: boolean;
  maxSubordinates?: number | null;
  wipLimits?: Record<string, number>;
  freeze?: boolean;
}

export interface AutonomyState {
  /** Chronological (oldest → newest), bounded to AUTONOMY_RING_MAX. */
  events: AutonomyEvent[];
  config: AutonomyConfigLike | null;
  /** True once the initial REST hydrate landed. */
  initialized: boolean;
}

export const AUTONOMY_RING_MAX = 100;

export const INITIAL_AUTONOMY_STATE: AutonomyState = {
  events: [],
  config: null,
  initialized: false,
};

export interface AutonomySlice {
  autonomy: Map<number, AutonomyState>;
  autonomyPushEvent: (sessionId: number, ev: AutonomyEvent) => void;
  autonomyHydrate: (
    sessionId: number,
    snapshot: { config?: AutonomyConfigLike | null; events?: AutonomyEvent[] },
  ) => void;
  autonomySetConfig: (sessionId: number, config: AutonomyConfigLike | null) => void;
  autonomyReset: (sessionId: number) => void;
}

function withSlot(
  prev: Map<number, AutonomyState>,
  sessionId: number,
  patch: (slot: AutonomyState) => AutonomyState,
): Map<number, AutonomyState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_AUTONOMY_STATE;
  next.set(sessionId, patch(current));
  return next;
}

/**
 * Weak identity for de-duping SSE replays (reconnect/remount) and
 * REST-hydrated vs already-live events. Server events carry a server-side
 * timestamp (`at` / `detectedAtMs`), so a replayed event maps to the same
 * key while two distinct events virtually never collide.
 */
function eventKey(ev: AutonomyEvent): string {
  return [
    ev.type, ev.event ?? '', ev.kind ?? '', ev.atMs,
    ev.role ?? '', ev.agentRunId ?? '', ev.cardId ?? '', ev.detail ?? '',
  ].join(':');
}

export const createAutonomySlice: StateCreator<AutonomySlice, [], [], AutonomySlice> = (set) => ({
  autonomy: new Map(),

  autonomyPushEvent: (sessionId, ev) =>
    set((state) => ({
      autonomy: withSlot(state.autonomy, sessionId, (slot) => {
        const key = eventKey(ev);
        if (slot.events.some((e) => eventKey(e) === key)) return slot; // SSE replay
        return { ...slot, events: [...slot.events, ev].slice(-AUTONOMY_RING_MAX) };
      }),
    })),

  autonomyHydrate: (sessionId, snapshot) =>
    set((state) => ({
      autonomy: withSlot(state.autonomy, sessionId, (slot) => {
        // Live events may already be in the ring (stream connected before
        // the panel mounted). Seed the historical REST events BEFORE them,
        // dropping near-duplicates, then re-sort chronologically.
        const seeded = Array.isArray(snapshot.events) ? snapshot.events : [];
        const liveKeys = new Set(slot.events.map(eventKey));
        const merged = [
          ...seeded.filter((ev) => ev && !liveKeys.has(eventKey(ev))),
          ...slot.events,
        ]
          .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))
          .slice(-AUTONOMY_RING_MAX);
        return {
          ...slot,
          events: merged,
          config: snapshot.config ?? slot.config,
          initialized: true,
        };
      }),
    })),

  autonomySetConfig: (sessionId, config) =>
    set((state) => ({
      autonomy: withSlot(state.autonomy, sessionId, (slot) => ({ ...slot, config })),
    })),

  autonomyReset: (sessionId) =>
    set((state) => {
      if (!state.autonomy.has(sessionId)) return state;
      const next = new Map(state.autonomy);
      next.delete(sessionId);
      return { autonomy: next };
    }),
});
