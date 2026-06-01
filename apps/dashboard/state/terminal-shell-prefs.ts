/**
 * Terminal shell preferences — which shell the "+" button reopens and
 * any custom shells the user added by hand.
 *
 * Two pieces of persisted state:
 *   - `preferredShellId`: the last shell the user picked, so "+" reopens
 *     the same one across reloads (matches the user's expectation that
 *     the terminal "remembers" their choice).
 *   - `customShells`: shells the user pointed at manually (a path the
 *     auto-detector didn't find). Merged with the detected list at render.
 *
 * The DETECTED list is NOT persisted — it's fetched fresh each session
 * via `apiCall('terminal.listShells')`, because installed shells can
 * change between runs (new WSL distro, Git installed, etc.).
 *
 * Mirrors the persistence pattern in `state/terminal-sessions.ts`; the
 * `TerminalShell` shape is duplicated (not imported from api-bus) to keep
 * the renderer build graph free of the api-bus package.
 */

import { create } from 'zustand';

/** Mirror of api-bus `TerminalShell` (`packages/api-bus/src/terminal.ts`). */
export interface TerminalShell {
  id: string;
  label: string;
  file: string;
  args?: string[];
}

interface ShellPrefsState {
  /** Last shell the user picked. Null until they choose (or on a fresh install). */
  preferredShellId: string | null;
  /** User-added shells (manual executable paths). */
  customShells: TerminalShell[];

  setPreferred: (id: string) => void;
  addCustom: (shell: TerminalShell) => void;
  removeCustom: (id: string) => void;
}

const STORAGE_KEY = 'mcp-ide:terminal-shell-prefs';

interface PersistedSnapshot {
  preferredShellId: string | null;
  customShells: TerminalShell[];
}

function loadPersisted(): PersistedSnapshot {
  const empty: PersistedSnapshot = { preferredShellId: null, customShells: [] };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
    return {
      preferredShellId: parsed.preferredShellId ?? null,
      customShells: Array.isArray(parsed.customShells) ? parsed.customShells : [],
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

export const useShellPrefs = create<ShellPrefsState>((set, get) => ({
  ...loadPersisted(),

  setPreferred: (id) =>
    set((s) => {
      const next: PersistedSnapshot = { preferredShellId: id, customShells: s.customShells };
      persist(next);
      return { preferredShellId: id };
    }),

  addCustom: (shell) =>
    set((s) => {
      // Replace any existing custom shell with the same id (re-adding a
      // path just updates its label), else append.
      const customShells = [...s.customShells.filter((c) => c.id !== shell.id), shell];
      persist({ preferredShellId: s.preferredShellId, customShells });
      return { customShells };
    }),

  removeCustom: (id) =>
    set((s) => {
      const customShells = s.customShells.filter((c) => c.id !== id);
      const preferredShellId = s.preferredShellId === id ? null : s.preferredShellId;
      persist({ preferredShellId, customShells });
      return { customShells, preferredShellId };
    }),
}));

/**
 * Merge the freshly-detected shells with the user's custom entries,
 * de-duplicating by id (detected wins on collision so a real install
 * shadows a stale custom path).
 */
export function mergeShells(detected: TerminalShell[], custom: TerminalShell[]): TerminalShell[] {
  const ids = new Set(detected.map((s) => s.id));
  return [...detected, ...custom.filter((c) => !ids.has(c.id))];
}

/** Resolve the shell to spawn: the preferred one if still present, else the first available. */
export function resolveActiveShell(
  shells: TerminalShell[],
  preferredId: string | null,
): TerminalShell | null {
  if (shells.length === 0) return null;
  return shells.find((s) => s.id === preferredId) ?? shells[0];
}
