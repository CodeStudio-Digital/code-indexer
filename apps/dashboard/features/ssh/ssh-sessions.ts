/**
 * In-memory registry of OPEN SSH shells, per project.
 *
 * Unlike the local workspace terminal (`state/terminal-sessions.ts`, which
 * persists to localStorage), SSH shells are deliberately NOT persisted: a
 * full reload tears down the main-process `ssh2` connection + PTY, so a
 * persisted `terminalId` would point at a dead shell. A module-singleton
 * Zustand store survives bottom-panel toggles and tab switches (which only
 * unmount the React tree) while correctly resetting on a real reload.
 *
 * The PTY/connection lifetime lives in the main process (sharedSshManager +
 * sharedPtyManager); this store is just the project↔shell mapping for the UI.
 */

import { create } from 'zustand';

export interface SshShell {
  /** Backend terminalId in the shared PTY manager — drive it via `terminal.*`. */
  terminalId: string;
  /** Pooled-connection key, so close can `ssh.disconnect` it. */
  hostId: string;
  /** Tab label, e.g. `user@host`. */
  label: string;
}

interface SshSessionsState {
  byProject: Record<number, SshShell[]>;
  activeByProject: Record<number, string | undefined>;
  /** Append a shell and focus it. */
  add: (projectId: number, shell: SshShell) => void;
  /** Drop a shell; focus falls back to the last remaining sibling. */
  remove: (projectId: number, terminalId: string) => void;
  /** Focus an existing shell. */
  setActive: (projectId: number, terminalId: string) => void;
}

export const useSshSessions = create<SshSessionsState>((set) => ({
  byProject: {},
  activeByProject: {},

  add: (projectId, shell) =>
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: [...(s.byProject[projectId] ?? []), shell] },
      activeByProject: { ...s.activeByProject, [projectId]: shell.terminalId },
    })),

  remove: (projectId, terminalId) =>
    set((s) => {
      const list = (s.byProject[projectId] ?? []).filter((x) => x.terminalId !== terminalId);
      const wasActive = s.activeByProject[projectId] === terminalId;
      return {
        byProject: { ...s.byProject, [projectId]: list },
        activeByProject: {
          ...s.activeByProject,
          [projectId]: wasActive ? list[list.length - 1]?.terminalId : s.activeByProject[projectId],
        },
      };
    }),

  setActive: (projectId, terminalId) =>
    set((s) => ({ activeByProject: { ...s.activeByProject, [projectId]: terminalId } })),
}));
