/**
 * Persistent terminal session registry — survives bottom-panel toggles,
 * tab switches, renderer reloads, project / company-session switches.
 *
 * Each "scope" owns an ORDERED list of terminal sessions plus a pointer
 * to the active one. A scope is just a stable string key the caller
 * decides:
 *
 *   - workspace terminal:        `project:42`
 *   - company-session terminal:  `company:7`
 *   - future ad-hoc terminals:   anything sensible (e.g. `tool:debug-x`)
 *
 * Each session also carries the spawn target so the prune+restore path
 * on reload can re-attach to the same kind of PTY (host shell vs. the
 * project's container vs. the company sandbox).
 *
 * The PTY lifetime lives in the main process's PtyManager
 * (packages/api-handlers/src/terminal). This store is just the
 * scope↔terminal mapping — the bytes/scrollback live there.
 */

import { create } from 'zustand';

/**
 * Mirror of the api-bus `TerminalTarget` shape
 * (`packages/api-bus/src/terminal.ts`). Duplicated here (instead of
 * imported) to avoid pulling the api-bus into the renderer store; the
 * wire shape is small and stable enough that this trade-off pays for
 * itself in build-graph simplicity.
 */
export type TerminalSpawnTarget =
  | { kind: 'host' }
  | { kind: 'project'; projectId: number }
  | { kind: 'sandbox'; sessionId: string };

export interface TerminalSession {
  /** Backend `terminalId` from `terminal.spawn`. */
  id: string;
  /** User-visible label shown on the tab. */
  name: string;
  /** Spawn timestamp (Date.now()). For sort + future "newest" hints. */
  createdAt: number;
  /**
   * Spawn target used to create this PTY. Persisted so the mount-time
   * "prune dead entries" probe knows what to respawn when the user
   * explicitly asks for "+ same again". Older persisted rows may lack
   * this field — treat as host.
   */
  target?: TerminalSpawnTarget;
  /**
   * Shell this PTY was spawned with (executable path + argv). Persisted so
   * "restart" re-launches the same shell instead of falling back to the
   * system default. Older rows may lack these — treat as the default shell.
   */
  shell?: string;
  shellArgs?: string[];
}

interface TerminalSessionsState {
  /** scope → ordered list of sessions. Missing = empty list. */
  byScope: Record<string, TerminalSession[]>;
  /** scope → active terminalId. Missing = no active (or list empty). */
  activeByScope: Record<string, string>;
  /**
   * scope → next sequence number to assign as a label. Cheap monotonic
   * counter so closing tabs doesn't reuse numbers (less confusing).
   */
  nextSeqByScope: Record<string, number>;

  /** Append a new session and make it active. Returns the session. */
  addSession: (
    scope: string,
    terminalId: string,
    target?: TerminalSpawnTarget,
    shell?: { file: string; args?: string[] },
  ) => TerminalSession;
  /**
   * Drop a session from the list (does NOT call the backend kill — the
   * caller is responsible for that). Updates active if it pointed at
   * this id.
   */
  removeSession: (scope: string, terminalId: string) => void;
  /** Switch the active session. No-op if the id isn't in the scope's list. */
  setActive: (scope: string, terminalId: string) => void;
  /**
   * Replace the entire list (used by the panel's mount probe to prune
   * entries pointing at dead PTYs).
   */
  replaceSessions: (scope: string, sessions: TerminalSession[]) => void;
}

/** Convenience helpers — keep call sites readable. */
export function projectScope(projectId: number): string {
  return `project:${projectId}`;
}

export function companyScope(companySessionId: string): string {
  return `company:${companySessionId}`;
}

const STORAGE_KEY = 'mcp-ide:terminal-sessions';
/** Legacy key prefix used before the scope rename — drained on first load. */
const LEGACY_PROJECT_PREFIX = 'project:';

interface PersistedSnapshot {
  byScope: Record<string, TerminalSession[]>;
  activeByScope: Record<string, string>;
  nextSeqByScope: Record<string, number>;
}

interface LegacySnapshot {
  byProject?: Record<string, TerminalSession[]>;
  activeByProject?: Record<string, string>;
  nextSeqByProject?: Record<string, number>;
}

function loadPersisted(): PersistedSnapshot {
  const empty: PersistedSnapshot = { byScope: {}, activeByScope: {}, nextSeqByScope: {} };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedSnapshot> & LegacySnapshot;
    // New shape wins when present.
    if (parsed.byScope || parsed.activeByScope || parsed.nextSeqByScope) {
      return {
        byScope: parsed.byScope ?? {},
        activeByScope: parsed.activeByScope ?? {},
        nextSeqByScope: parsed.nextSeqByScope ?? {},
      };
    }
    // Migration: convert the legacy `byProject` map (numeric keys) into
    // `byScope` (`project:<id>`). One-shot, transparent to call sites.
    const next: PersistedSnapshot = { byScope: {}, activeByScope: {}, nextSeqByScope: {} };
    for (const [k, v] of Object.entries(parsed.byProject ?? {})) {
      next.byScope[`${LEGACY_PROJECT_PREFIX}${k}`] = v;
    }
    for (const [k, v] of Object.entries(parsed.activeByProject ?? {})) {
      next.activeByScope[`${LEGACY_PROJECT_PREFIX}${k}`] = v;
    }
    for (const [k, v] of Object.entries(parsed.nextSeqByProject ?? {})) {
      next.nextSeqByScope[`${LEGACY_PROJECT_PREFIX}${k}`] = v;
    }
    return next;
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

  addSession: (scope, terminalId, target, shell) => {
    const existingList = get().byScope[scope] ?? [];
    const seq = (get().nextSeqByScope[scope] ?? 0) + 1;
    const session: TerminalSession = {
      id: terminalId,
      name: `Terminal ${seq}`,
      createdAt: Date.now(),
      target,
      shell: shell?.file,
      shellArgs: shell?.args,
    };
    set((s) => {
      const next: PersistedSnapshot = {
        byScope: { ...s.byScope, [scope]: [...existingList, session] },
        activeByScope: { ...s.activeByScope, [scope]: terminalId },
        nextSeqByScope: { ...s.nextSeqByScope, [scope]: seq },
      };
      persist(next);
      return next;
    });
    return session;
  },

  removeSession: (scope, terminalId) =>
    set((s) => {
      const list = s.byScope[scope];
      if (!list) return s;
      const filtered = list.filter((t) => t.id !== terminalId);
      const wasActive = s.activeByScope[scope] === terminalId;
      // When closing the active tab, fall back to the last remaining
      // session (matches VS Code: focus jumps to the most recent
      // sibling). Empty list → no active.
      const nextActive = wasActive
        ? filtered[filtered.length - 1]?.id
        : s.activeByScope[scope];
      const next: PersistedSnapshot = {
        byScope: { ...s.byScope, [scope]: filtered },
        activeByScope: { ...s.activeByScope },
        nextSeqByScope: s.nextSeqByScope,
      };
      if (nextActive) next.activeByScope[scope] = nextActive;
      else delete next.activeByScope[scope];
      persist(next);
      return next;
    }),

  setActive: (scope, terminalId) =>
    set((s) => {
      const list = s.byScope[scope] ?? [];
      if (!list.some((t) => t.id === terminalId)) return s;
      const next: PersistedSnapshot = {
        byScope: s.byScope,
        activeByScope: { ...s.activeByScope, [scope]: terminalId },
        nextSeqByScope: s.nextSeqByScope,
      };
      persist(next);
      return next;
    }),

  replaceSessions: (scope, sessions) =>
    set((s) => {
      const currentActive = s.activeByScope[scope];
      const stillThere = sessions.some((t) => t.id === currentActive);
      const nextActive = stillThere ? currentActive : sessions[sessions.length - 1]?.id;
      const nextActiveMap = { ...s.activeByScope };
      if (nextActive) nextActiveMap[scope] = nextActive;
      else delete nextActiveMap[scope];
      const next: PersistedSnapshot = {
        byScope: { ...s.byScope, [scope]: sessions },
        activeByScope: nextActiveMap,
        nextSeqByScope: s.nextSeqByScope,
      };
      persist(next);
      return next;
    }),
}));
