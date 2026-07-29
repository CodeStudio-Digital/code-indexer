/**
 * Sandbox events per company session.
 *
 * Phase 2 routes `sandbox.file_changed` SSE events into this slice so
 * components don't have to subscribe to a custom DOM event
 * (`window.addEventListener('sandbox:file-changed:${id}')`). The previous
 * bridge made the event flow opaque — consumers couldn't react to it via
 * zustand, only via DOM lifecycle hooks.
 *
 * Slot shape stays narrow on purpose: only the most-recent change is
 * kept. Consumers that need a history can subscribe and accumulate
 * locally. Per-service scoping lives in the payload so a multi-service
 * sandbox can filter (`only react when serviceId === 'api'`).
 */
import type { StateCreator } from 'zustand';
import {
  appendServiceLogLines,
  type IncomingServiceLogLine,
  type ServiceLogEntry,
} from './service-log-buffer.js';

export type { ServiceLogEntry } from './service-log-buffer.js';

export interface SandboxFileChange {
  path: string;
  serviceId?: string;
  changeType?: 'created' | 'modified' | 'deleted' | string;
  /** Monotonic counter — increments on every event so consumers can
   *  `useEffect(..., [lastFileChange?.seq])` without comparing objects. */
  seq: number;
  /** `Date.now()` at receive time, for staleness checks. */
  at: number;
}

export interface SandboxState {
  lastFileChange: SandboxFileChange | null;
  /**
   * Monotonic counter bumped whenever the backend publishes a
   * sandbox status/lifecycle event (`sandbox.status_changed`,
   * `sandbox.ready`, `sandbox.paused`, `sandbox.error`, `sandbox.destroyed`).
   * Replaces the 1.5s setInterval poll in `useSandboxStatus`.
   * Components depend on this seq via `useEffect(..., [seq])` and
   * call their fetch on bump.
   */
  statusSeq: number;
  /**
   * Same pattern for `/services` list mutations
   * (`sandbox.service.added`, `sandbox.service.removed`,
   * `sandbox.service.status_changed`; B6 also bumps on `.health` and
   * `.restarted` so the sidebar badges refresh). Replaces the 4-5s
   * polls across `useServicesPolling` and `useExtraServices`.
   */
  servicesSeq: number;
  /**
   * B6 — live tail buffers fed by `sandbox.service.log_batch`, bounded
   * to 500 lines per service (`service-log-buffer.ts`). Keyed by
   * serviceId; history/pagination stays REST-side (ServiceLogsPane).
   */
  serviceLogs: Record<string, ServiceLogEntry[]>;
  /**
   * B8 — last supervisor verdict per serviceId, fed by
   * `sandbox.service.health` SSE. Container rows also get health from
   * the `/services` refetch (persisted column); HOST-process rows
   * (`local:<id>`) have NO persisted health — this map is their only
   * live source, overlaid by the services sidebar.
   */
  serviceHealth: Record<string, ServiceHealthEntry>;
}

export interface ServiceHealthEntry {
  health: string;
  detail: string | null;
  /** Epoch-ms from the event payload (supervisor clock). */
  at: number;
}

export const INITIAL_SANDBOX_STATE: SandboxState = {
  lastFileChange: null,
  statusSeq: 0,
  servicesSeq: 0,
  serviceLogs: {},
  serviceHealth: {},
};

export interface SandboxSlice {
  sandbox: Map<string, SandboxState>;
  sandboxEnsure: (sessionId: string) => void;
  sandboxApplyFileChange: (
    sessionId: string,
    payload: Omit<SandboxFileChange, 'seq' | 'at'>,
  ) => void;
  /** Bumps `statusSeq`. Consumers refetch `/sandbox` on each tick. */
  sandboxBumpStatus: (sessionId: string) => void;
  /** Bumps `servicesSeq`. Consumers refetch `/services` on each tick. */
  sandboxBumpServices: (sessionId: string) => void;
  /** Appends a `sandbox.service.log_batch` payload to the bounded live buffer. */
  sandboxAppendServiceLogs: (
    sessionId: string,
    serviceId: string,
    lines: IncomingServiceLogLine[],
  ) => void;
  /** B8 — records a `sandbox.service.health` verdict for overlay reads. */
  sandboxApplyServiceHealth: (
    sessionId: string,
    serviceId: string,
    health: string,
    detail: string | null,
    at: number,
  ) => void;
  sandboxReset: (sessionId: string) => void;
}

function withSlot(
  prev: Map<string, SandboxState>,
  sessionId: string,
  patch: (slot: SandboxState) => SandboxState,
): Map<string, SandboxState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_SANDBOX_STATE;
  next.set(sessionId, patch(current));
  return next;
}

export const createSandboxSlice: StateCreator<SandboxSlice, [], [], SandboxSlice> = (set) => ({
  sandbox: new Map(),

  sandboxEnsure: (sessionId) =>
    set((state) => {
      if (state.sandbox.has(sessionId)) return state;
      const next = new Map(state.sandbox);
      next.set(sessionId, INITIAL_SANDBOX_STATE);
      return { sandbox: next };
    }),

  sandboxApplyFileChange: (sessionId, payload) =>
    set((state) => ({
      sandbox: withSlot(state.sandbox, sessionId, (slot) => ({
        ...slot,
        lastFileChange: {
          ...payload,
          seq: (slot.lastFileChange?.seq ?? 0) + 1,
          at: Date.now(),
        },
      })),
    })),

  sandboxBumpStatus: (sessionId) =>
    set((state) => ({
      sandbox: withSlot(state.sandbox, sessionId, (slot) => ({
        ...slot,
        statusSeq: slot.statusSeq + 1,
      })),
    })),

  sandboxBumpServices: (sessionId) =>
    set((state) => ({
      sandbox: withSlot(state.sandbox, sessionId, (slot) => ({
        ...slot,
        servicesSeq: slot.servicesSeq + 1,
      })),
    })),

  sandboxAppendServiceLogs: (sessionId, serviceId, lines) =>
    set((state) => ({
      sandbox: withSlot(state.sandbox, sessionId, (slot) => ({
        ...slot,
        serviceLogs: {
          ...slot.serviceLogs,
          [serviceId]: appendServiceLogLines(slot.serviceLogs?.[serviceId], lines),
        },
      })),
    })),

  sandboxApplyServiceHealth: (sessionId, serviceId, health, detail, at) =>
    set((state) => ({
      sandbox: withSlot(state.sandbox, sessionId, (slot) => ({
        ...slot,
        serviceHealth: {
          ...(slot.serviceHealth ?? {}),
          [serviceId]: { health, detail, at },
        },
      })),
    })),

  sandboxReset: (sessionId) =>
    set((state) => {
      if (!state.sandbox.has(sessionId)) return state;
      const next = new Map(state.sandbox);
      next.delete(sessionId);
      return { sandbox: next };
    }),
});
