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
}

export const INITIAL_SANDBOX_STATE: SandboxState = {
  lastFileChange: null,
};

export interface SandboxSlice {
  sandbox: Map<number, SandboxState>;
  sandboxEnsure: (sessionId: number) => void;
  sandboxApplyFileChange: (
    sessionId: number,
    payload: Omit<SandboxFileChange, 'seq' | 'at'>,
  ) => void;
  sandboxReset: (sessionId: number) => void;
}

function withSlot(
  prev: Map<number, SandboxState>,
  sessionId: number,
  patch: (slot: SandboxState) => SandboxState,
): Map<number, SandboxState> {
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

  sandboxReset: (sessionId) =>
    set((state) => {
      if (!state.sandbox.has(sessionId)) return state;
      const next = new Map(state.sandbox);
      next.delete(sessionId);
      return { sandbox: next };
    }),
});
