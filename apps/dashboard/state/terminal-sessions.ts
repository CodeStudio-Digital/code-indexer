/**
 * Persistent terminal session registry — survives bottom-panel toggles,
 * tab switches, renderer reloads, project switches.
 *
 * Each project owns an ORDERED list of terminal sessions plus a pointer
 * to the active one. The user can:
 *   - open multiple terminals per project (VS Code-style tabs)
 *   - close any single terminal (kills the PTY in backend)
 *   - switch between them (re-attach replays the buffer)
 *   - close the BottomPanel entirely (PTYs stay alive in backend)
 *   - reload the Electron window (localStorage restores the list;
 *     dead PTYs get pruned by WorkspaceTerminal's probe on mount)
 *
 * The PTY lifetime lives in the main process's PtyManager
 * (packages/api-handlers/src/terminal). This store is just the
 * project↔terminal mapping — the bytes/scrollback live there.
 */

import { create } from 'zustand';

export interface TerminalSession {
  /** Backend `terminalId` from `terminal.spawn`. */
  id: string;
  /** User-visible label shown on the tab. */
  name: string;
  /** Spawn timestamp (Date.now()). For sort + future "newest" hints. */
  createdAt: number;
}

interface TerminalSessionsState {
  /** projectId → ordered list of sessions. Missing = empty list. */
  byProject: Record<number, TerminalSession[]>;
  /** projectId → active terminalId. Missing = no active (or list empty). */
  activeByProject: Record<number, string>;
  /** projectId → next sequence number to assign as a label. Cheap monotonic
   *  counter so closing tabs doesn't reuse numbers (less confusing). */
  nextSeqByProject: Record<number, number>;

  /** Append a new session and make it active. Returns the seq used for naming. */
  addSession: (projectId: number, terminalId: string) => TerminalSession;
  /** Drop a session from the list (does NOT call the backend kill — the
   *  caller is responsible for that). Updates active if it pointed at this id. */
  removeSession: (projectId: number, terminalId: string) => void;
  /** Switch the active session. No-op if the id isn't in the project's list. */
  setActive: (projectId: number, terminalId: string) => void;
  /** Replace the entire list (used by the WorkspaceTerminal mount probe
   *  to prune entries pointing at dead PTYs). */
  replaceSessions: (projectId: number, sessions: TerminalSession[]) => void;
}

const STORAGE_KEY = 'mcp-ide:terminal-sessions';

interface PersistedSnapshot {
  byProject: Record<number, TerminalSession[]>;
  activeByProject: Record<number, string>;
  nextSeqByProject: Record<number, number>;
}

function loadPersisted(): PersistedSnapshot {
  const empty: PersistedSnapshot = { byProject: {}, activeByProject: {}, nextSeqByProject: {} };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
    // Coerce numeric keys (JSON.stringify turns them into strings).
    const coerce = <T>(src: Record<string, T> | undefined): Record<number, T> => {
      if (!src) return {};
      const out: Record<number, T> = {};
      for (const [k, v] of Object.entries(src)) {
        const n = Number(k);
        if (Number.isFinite(n)) out[n] = v;
      }
      return out;
    };
    return {
      byProject: coerce(parsed.byProject as Record<string, TerminalSession[]> | undefined),
      activeByProject: coerce(parsed.activeByProject as Record<string, string> | undefined),
      nextSeqByProject: coerce(parsed.nextSeqByProject as Record<string, number> | undefined),
    };
  } catch {
    return empty;
  }
}

function persist(snap: PersistedSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => ({
  ...loadPersisted(),

  addSession: (projectId, terminalId) => {
    const existingList = get().byProject[projectId] ?? [];
    const seq = (get().nextSeqByProject[projectId] ?? 0) + 1;
    const session: TerminalSession = {
      id: terminalId,
      name: `Terminal ${seq}`,
      createdAt: Date.now(),
    };
    set((s) => {
      const next: PersistedSnapshot = {
        byProject: { ...s.byProject, [projectId]: [...existingList, session] },
        activeByProject: { ...s.activeByProject, [projectId]: terminalId },
        nextSeqByProject: { ...s.nextSeqByProject, [projectId]: seq },
      };
      persist(next);
      return next;
    });
    return session;
  },

  removeSession: (projectId, terminalId) =>
    set((s) => {
      const list = s.byProject[projectId];
      if (!list) return s;
      const filtered = list.filter((t) => t.id !== terminalId);
      const wasActive = s.activeByProject[projectId] === terminalId;
      // When closing the active tab, fall back to the last remaining
      // session (matches VS Code: focus jumps to the most recent
      // sibling). Empty list → no active.
      const nextActive = wasActive
        ? filtered[filtered.length - 1]?.id
        : s.activeByProject[projectId];
      const next: PersistedSnapshot = {
        byProject: { ...s.byProject, [projectId]: filtered },
        activeByProject: { ...s.activeByProject },
        nextSeqByProject: s.nextSeqByProject,
      };
      if (nextActive) next.activeByProject[projectId] = nextActive;
      else delete next.activeByProject[projectId];
      persist(next);
      return next;
    }),

  setActive: (projectId, terminalId) =>
    set((s) => {
      const list = s.byProject[projectId] ?? [];
      if (!list.some((t) => t.id === terminalId)) return s;
      const next: PersistedSnapshot = {
        byProject: s.byProject,
        activeByProject: { ...s.activeByProject, [projectId]: terminalId },
        nextSeqByProject: s.nextSeqByProject,
      };
      persist(next);
      return next;
    }),

  replaceSessions: (projectId, sessions) =>
    set((s) => {
      // Preserve activeByProject if the active id is still in the new list,
      // otherwise fall back to the last session (or clear if empty).
      const currentActive = s.activeByProject[projectId];
      const stillThere = sessions.some((t) => t.id === currentActive);
      const nextActive = stillThere ? currentActive : sessions[sessions.length - 1]?.id;
      const nextActiveMap = { ...s.activeByProject };
      if (nextActive) nextActiveMap[projectId] = nextActive;
      else delete nextActiveMap[projectId];
      const next: PersistedSnapshot = {
        byProject: { ...s.byProject, [projectId]: sessions },
        activeByProject: nextActiveMap,
        nextSeqByProject: s.nextSeqByProject,
      };
      persist(next);
      return next;
    }),
}));
