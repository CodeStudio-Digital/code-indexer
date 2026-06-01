/**
 * Company shared-drive state per session.
 *
 * Phase 2 routes `drive.file_added | updated | deleted` SSE events into
 * this slice. `DrivePanel` reads from the slice and stops polling the
 * `/drive` endpoint every 5 s while the SSE stream is live. The poll
 * fallback only fires when the stream disconnects (the panel decides
 * locally based on `useCompanyStream().connected`).
 *
 * Scope (template-shared vs session-scoped) is recorded for display
 * purposes only — the backend resolves it and includes it in the
 * `GET /drive` response, plus every SSE payload identifies the path so
 * the slice never needs to compute scope locally.
 */
import type { StateCreator } from 'zustand';

export interface DriveFileMeta {
  id: number;
  scopeKey: string;
  path: string;
  sizeBytes: number;
  mime: string;
  ownerRole: string | null;
  ownerAgentRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriveState {
  /** Keyed by file path so add/update/delete is O(1). */
  files: Map<string, DriveFileMeta>;
  /** Backend-resolved scope key (`tpl:N` or `ses:N`). Shown as a chip. */
  scope: string | null;
  /** True once the initial REST fetch landed. */
  initialized: boolean;
  loading: boolean;
  error: string | null;
}

export const INITIAL_DRIVE_STATE: DriveState = {
  files: new Map(),
  scope: null,
  initialized: false,
  loading: false,
  error: null,
};

export interface DriveSlice {
  drive: Map<number, DriveState>;
  driveEnsure: (sessionId: number) => void;
  driveSetLoading: (sessionId: number, loading: boolean) => void;
  driveSetError: (sessionId: number, error: string | null) => void;
  /** Replace the entire file map (initial REST load). */
  driveHydrate: (sessionId: number, scope: string, files: DriveFileMeta[]) => void;
  driveApplyAdded: (sessionId: number, meta: DriveFileMeta) => void;
  driveApplyUpdated: (sessionId: number, meta: DriveFileMeta) => void;
  driveApplyDeleted: (sessionId: number, path: string) => void;
  driveReset: (sessionId: number) => void;
}

function withSlot(
  prev: Map<number, DriveState>,
  sessionId: number,
  patch: (slot: DriveState) => DriveState,
): Map<number, DriveState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_DRIVE_STATE;
  next.set(sessionId, patch(current));
  return next;
}

function withFiles(
  prev: Map<number, DriveState>,
  sessionId: number,
  patch: (files: Map<string, DriveFileMeta>) => Map<string, DriveFileMeta>,
): Map<number, DriveState> {
  return withSlot(prev, sessionId, (slot) => ({ ...slot, files: patch(slot.files) }));
}

export const createDriveSlice: StateCreator<DriveSlice, [], [], DriveSlice> = (set) => ({
  drive: new Map(),

  driveEnsure: (sessionId) =>
    set((state) => {
      if (state.drive.has(sessionId)) return state;
      const next = new Map(state.drive);
      next.set(sessionId, INITIAL_DRIVE_STATE);
      return { drive: next };
    }),

  driveSetLoading: (sessionId, loading) =>
    set((state) => ({
      drive: withSlot(state.drive, sessionId, (slot) => ({ ...slot, loading })),
    })),

  driveSetError: (sessionId, error) =>
    set((state) => ({
      drive: withSlot(state.drive, sessionId, (slot) => ({ ...slot, error })),
    })),

  driveHydrate: (sessionId, scope, files) =>
    set((state) => ({
      drive: withSlot(state.drive, sessionId, (slot) => ({
        ...slot,
        scope,
        files: new Map((Array.isArray(files) ? files : []).map((f) => [f.path, f])),
        initialized: true,
        error: null,
      })),
    })),

  driveApplyAdded: (sessionId, meta) =>
    set((state) => ({
      drive: withFiles(state.drive, sessionId, (prev) => {
        const next = new Map(prev);
        next.set(meta.path, meta);
        return next;
      }),
    })),

  driveApplyUpdated: (sessionId, meta) =>
    set((state) => ({
      drive: withFiles(state.drive, sessionId, (prev) => {
        const next = new Map(prev);
        next.set(meta.path, meta);
        return next;
      }),
    })),

  driveApplyDeleted: (sessionId, path) =>
    set((state) => ({
      drive: withFiles(state.drive, sessionId, (prev) => {
        if (!prev.has(path)) return prev;
        const next = new Map(prev);
        next.delete(path);
        return next;
      }),
    })),

  driveReset: (sessionId) =>
    set((state) => {
      if (!state.drive.has(sessionId)) return state;
      const next = new Map(state.drive);
      next.delete(sessionId);
      return { drive: next };
    }),
});
