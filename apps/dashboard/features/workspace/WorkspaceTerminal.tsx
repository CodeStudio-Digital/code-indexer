/**
 * Workspace terminal — multi-tab terminal panel wired to the api-bus
 * `terminal.*` surface, scoped to a single project.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ [● Terminal 1] [Terminal 2] [+]                       [×] │  ← tab bar
 *   ├────────────────────────────────────────────────────────────┤
 *   │   xterm.js renders here (the active session)               │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Persistence + tab interactions live in the shared store
 * (`state/terminal-sessions.ts`). The renderer + tab bar are shared
 * with the agents view via `features/shared/terminal/*`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import { apiCall, electronApi } from '../../lib/api-client.js';
import {
  projectScope,
  useTerminalSessions,
  type TerminalSession,
} from '../../state/terminal-sessions.js';
import { SingleTerminal, TERMINAL_SURFACE_BG } from '../shared/terminal/SingleTerminal.js';
import { TerminalTabBar } from '../shared/terminal/TerminalTabBar.js';
import { useShellPicker } from '../shared/terminal/use-shell-picker.js';
import { useIsDark } from '../builder/preview/files/viewer/useIsDark.js';
import { navigateToProjectLocation } from './editor/nav-commands.js';

interface WorkspaceTerminalProps {
  projectId: number;
}

interface SpawnResult {
  terminalId: string;
  pid: number;
  shell: string;
  cwd: string;
}

/**
 * Stable empty array used as the fallback in selector returns. Without
 * this, `s.byScope[scope] ?? []` materialises a fresh `[]` on every
 * selector call — Zustand's reference-equality check fires a re-render
 * every time. See git blame on this file for the original incident.
 */
const EMPTY_SESSIONS: readonly TerminalSession[] = Object.freeze([]);

export function WorkspaceTerminal({ projectId }: WorkspaceTerminalProps) {
  const scope = projectScope(projectId);
  const sessions = useTerminalSessions(
    (s) => (s.byScope[scope] ?? EMPTY_SESSIONS) as TerminalSession[],
  );
  const activeId = useTerminalSessions((s) => s.activeByScope[scope]);
  const { addSession, removeSession, setActive, replaceSessions } = useTerminalSessions.getState();

  const hasElectron = !!electronApi();
  const dark = useIsDark();
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { shells, activeShell, selectShell, addCustomShell } = useShellPicker();

  /**
   * Spawn a fresh PTY scoped to this project and add it to the store.
   * `shellOverride` lets restart re-launch the exact shell the dead tab
   * used; otherwise we spawn the currently-selected shell.
   */
  const spawnNew = useCallback(
    async (shellOverride?: { file: string; args?: string[] }) => {
      if (busy) return;
      setBusy(true);
      setSpawnError(null);
      try {
        const target = { kind: 'project' as const, projectId };
        const shell = shellOverride ?? activeShell ?? undefined;
        const spawn = await apiCall<SpawnResult>('terminal.spawn', {
          target,
          cols: 80,
          rows: 24,
          shell: shell?.file,
          shellArgs: shell?.args,
        });
        addSession(scope, spawn.terminalId, target, shell);
      } catch (err) {
        setSpawnError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [scope, projectId, busy, addSession, activeShell],
  );

  /**
   * Mount probe: prune dead persisted entries (PTYs that no longer
   * exist in the main process) AND autospawn a fresh terminal when
   * the surviving list is empty.
   */
  const probedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasElectron) return;
    if (probedScopeRef.current === scope) return;
    probedScopeRef.current = scope;
    void (async () => {
      const initial = useTerminalSessions.getState().byScope[scope] ?? [];
      const alive: TerminalSession[] = [];
      for (const s of initial) {
        try {
          await apiCall('terminal.resize', { terminalId: s.id, cols: 80, rows: 24 });
          alive.push(s);
        } catch {
          /* drop */
        }
      }
      if (alive.length !== initial.length) {
        replaceSessions(scope, alive);
      }
      if (alive.length === 0) {
        await spawnNew();
      }
    })();
    // spawnNew is stable via useCallback; we intentionally don't list
    // it to avoid re-running the probe on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, hasElectron, replaceSessions]);

  /** Close a single tab: kill PTY + drop from list. */
  const closeTab = useCallback(
    async (terminalId: string) => {
      removeSession(scope, terminalId);
      try {
        await apiCall('terminal.kill', { terminalId });
      } catch {
        /* PTY may have already exited — silent */
      }
    },
    [scope, removeSession],
  );

  /** Restart the active terminal: kill + spawn replacement with the same shell. */
  const restartActive = useCallback(async () => {
    if (!activeId) return;
    const current = sessions.find((s) => s.id === activeId);
    await closeTab(activeId);
    await spawnNew(current?.shell ? { file: current.shell, args: current.shellArgs } : undefined);
  }, [activeId, sessions, closeTab, spawnNew]);

  if (!hasElectron) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2 p-3">
        <AlertCircle className="h-4 w-4" />
        <span>Terminal requires the Electron app — browser dev fallback not wired.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <TerminalTabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => setActive(scope, id)}
        onClose={(id) => void closeTab(id)}
        onAdd={() => void spawnNew()}
        onRestart={() => void restartActive()}
        addDisabled={busy}
        shellOptions={shells}
        activeShellId={activeShell?.id}
        onSelectShell={selectShell}
        onAddCustomShell={() => void addCustomShell()}
      />
      {spawnError && (
        <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">
          {spawnError}
        </div>
      )}
      <div
        className="flex-1 min-h-0 relative"
        style={{ background: dark ? TERMINAL_SURFACE_BG.dark : TERMINAL_SURFACE_BG.light }}
      >
        {sessions.length === 0 && !busy && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => void spawnNew()}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-input hover:bg-muted transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New terminal</span>
            </button>
          </div>
        )}
        {activeId && (
          <SingleTerminal
            key={activeId}
            terminalId={activeId}
            onProcessExited={() => void closeTab(activeId)}
            onOpenPath={(path, line, column) =>
              navigateToProjectLocation({ projectId, path, line: line ?? 1, column: column ?? 1 })}
          />
        )}
      </div>
    </div>
  );
}
