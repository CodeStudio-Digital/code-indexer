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
  /**
   * 'shell' = interactive remote shell. 'snippet' = one-shot command run; its tab
   * is KEPT after exit so the user can read the output/log. Default 'shell'.
   */
  kind?: 'shell' | 'snippet';
  /** The underlying process has exited — set for kept (snippet) tabs. */
  exited?: boolean;
  /**
   * Connection state for SHELL tabs. Unset/'connected' = live; 'dropped' = the
   * channel closed (network blip / `exit`) and the tab is kept with a Reconnect
   * affordance; 'reconnecting' = a reconnect attempt is in flight.
   */
  state?: 'connected' | 'reconnecting' | 'dropped';
}

interface SshSessionsState {
  byProject: Record<number, SshShell[]>;
  activeByProject: Record<number, string | undefined>;
  panesByProject: Record<number, string[] | undefined>;
  toggleSplit: (projectId: number) => void;
  /** Append a shell and focus it. */
  add: (projectId: number, shell: SshShell) => void;
  /** Drop a shell; focus falls back to the last remaining sibling. */
  remove: (projectId: number, terminalId: string) => void;
  /** Mark a shell's process as exited WITHOUT removing its tab (snippet logs stay readable). */
  markExited: (projectId: number, terminalId: string) => void;
  /** Set a shell's connection state (drives the status dot + Reconnect affordance). */
  setShellState: (projectId: number, terminalId: string, state: SshShell['state']) => void;
  /** Reconnect succeeded: point the tab at the NEW terminalId and mark it connected. */
  swapTerminal: (projectId: number, oldTerminalId: string, newTerminalId: string) => void;
  /** Focus an existing shell. */
  setActive: (projectId: number, terminalId: string) => void;
}

function focusShell(s: SshSessionsState, projectId: number, id: string) {
  const active = s.activeByProject[projectId];
  const panes = s.panesByProject[projectId];
  return {
    activeByProject: { ...s.activeByProject, [projectId]: id },
    panesByProject: panes && !panes.includes(id)
      ? { ...s.panesByProject, [projectId]: panes.map(pane => pane === active ? id : pane) }
      : s.panesByProject,
  };
}

export const useSshSessions = create<SshSessionsState>((set) => ({
  byProject: {},
  activeByProject: {},
  panesByProject: {},
  toggleSplit: projectId => set(s => {
    const active = s.activeByProject[projectId];
    const other = s.byProject[projectId]?.find(shell => shell.terminalId !== active);
    if (!active || !other) return s;
    const panes = s.panesByProject[projectId] ? undefined : [active, other.terminalId];
    return { panesByProject: { ...s.panesByProject, [projectId]: panes } };
  }),

  add: (projectId, shell) =>
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: [...(s.byProject[projectId] ?? []), shell] },
      ...focusShell(s, projectId, shell.terminalId),
    })),

  remove: (projectId, terminalId) =>
    set((s) => {
      const list = (s.byProject[projectId] ?? []).filter((x) => x.terminalId !== terminalId);
      const wasActive = s.activeByProject[projectId] === terminalId;
      const panes = s.panesByProject[projectId];
      const otherPane = panes?.find(id => id !== terminalId);
      const replacement = list.find(shell => !panes?.includes(shell.terminalId));
      const nextPanes = panes?.includes(terminalId)
        ? (replacement ? panes.map(id => id === terminalId ? replacement.terminalId : id) : undefined)
        : panes;
      return {
        byProject: { ...s.byProject, [projectId]: list },
        panesByProject: { ...s.panesByProject, [projectId]: nextPanes },
        activeByProject: {
          ...s.activeByProject,
          [projectId]: wasActive ? otherPane ?? list[list.length - 1]?.terminalId : s.activeByProject[projectId],
        },
      };
    }),

  markExited: (projectId, terminalId) =>
    set((s) => {
      const list = s.byProject[projectId] ?? [];
      const target = list.find((x) => x.terminalId === terminalId);
      if (!target || target.exited) return s; // idempotent — no churn / re-render storm
      return {
        byProject: {
          ...s.byProject,
          [projectId]: list.map((x) => (x.terminalId === terminalId ? { ...x, exited: true } : x)),
        },
      };
    }),

  setShellState: (projectId, terminalId, state) =>
    set((s) => {
      const list = s.byProject[projectId] ?? [];
      const target = list.find((x) => x.terminalId === terminalId);
      if (!target || target.state === state) return s; // idempotent
      return {
        byProject: {
          ...s.byProject,
          [projectId]: list.map((x) => (x.terminalId === terminalId ? { ...x, state } : x)),
        },
      };
    }),

  swapTerminal: (projectId, oldTerminalId, newTerminalId) =>
    set((s) => {
      const list = s.byProject[projectId] ?? [];
      if (!list.some((x) => x.terminalId === oldTerminalId)) return s;
      const wasActive = s.activeByProject[projectId] === oldTerminalId;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: list.map((x) =>
            x.terminalId === oldTerminalId ? { ...x, terminalId: newTerminalId, state: 'connected', exited: false } : x,
          ),
        },
        activeByProject: wasActive ? { ...s.activeByProject, [projectId]: newTerminalId } : s.activeByProject,
        panesByProject: { ...s.panesByProject, [projectId]: s.panesByProject[projectId]?.map(id => id === oldTerminalId ? newTerminalId : id) },
      };
    }),

  setActive: (projectId, terminalId) =>
    set(s => s.activeByProject[projectId] === terminalId || !s.byProject[projectId]?.some(shell => shell.terminalId === terminalId)
      ? s : focusShell(s, projectId, terminalId)),
}));
