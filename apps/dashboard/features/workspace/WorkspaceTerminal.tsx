/**
 * Workspace terminal — multi-tab terminal panel wired to the api-bus
 * `terminal.*` surface.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ [● Terminal 1] [Terminal 2] [+]                       [×] │  ← tab bar
 *   ├────────────────────────────────────────────────────────────┤
 *   │                                                            │
 *   │   xterm.js renders here (the active session)               │
 *   │                                                            │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Persistence:
 *   - Each session is a real PTY in the main-process PtyManager.
 *   - The renderer keeps the project↔session list in
 *     `useTerminalSessions` (Zustand + localStorage), so the tab bar
 *     survives BottomPanel toggles, tab navigation, and renderer
 *     reloads. PtyManager survives renderer reloads too; only an
 *     Electron-app restart wipes the bytes.
 *
 * Tab interactions:
 *   - Click a tab → make it active (mounts a new SingleTerminal that
 *     attaches via `terminal.output(id)`, which replays the buffer
 *     before flowing live data).
 *   - + button → spawn a fresh PTY and add a new session.
 *   - × on a tab → kill the PTY in backend, drop it from the list.
 *     If it was the active tab, the previous sibling becomes active.
 *
 * Browser-dev fallback: terminal IPC only works inside Electron
 * (api-bus terminal.* requires node-pty in the main process). The
 * component renders a notice when `electronApi()` is null.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AlertCircle, Plus, RotateCcw, TerminalSquare, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiCall, apiStream, electronApi } from '../../lib/api-client.js';
import {
  useTerminalSessions,
  type TerminalSession,
} from '../../state/terminal-sessions.js';
import { cn } from '../../lib/utils.js';

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
 * this, `s.byProject[projectId] ?? []` materialises a fresh `[]` on
 * every selector call — Zustand's reference-equality check fires a
 * re-render every time, which re-runs the selector, which yields yet
 * another fresh `[]`. The loop tripped React's "Maximum update depth
 * exceeded" guard the moment the panel mounted for a project with no
 * sessions yet.
 */
const EMPTY_SESSIONS: readonly TerminalSession[] = Object.freeze([]);

export function WorkspaceTerminal({ projectId }: WorkspaceTerminalProps) {
  const sessions = useTerminalSessions(
    (s) => (s.byProject[projectId] ?? EMPTY_SESSIONS) as TerminalSession[],
  );
  const activeId = useTerminalSessions((s) => s.activeByProject[projectId]);
  // Pluck the action functions once via getState() — they're stable
  // references across store updates (Zustand keeps them on the prototype
  // of the state object) but the selector form
  // `useTerminalSessions((s) => s.addSession)` still subscribes the
  // component to the store and would force a re-evaluation on every
  // state change. Direct getState() reads avoid that subscription
  // entirely for callbacks that don't need to react to state.
  const { addSession, removeSession, setActive, replaceSessions } = useTerminalSessions.getState();

  const hasElectron = !!electronApi();
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * On first mount for a project, two jobs run in order:
   *   1. PRUNE stale sessions — probe each persisted terminalId via a
   *      cheap `terminal.resize` call. The ones that fail (PTY died,
   *      main restarted) get dropped from the list. The ones that
   *      survive stay.
   *   2. AUTOSPAWN — if the surviving list is empty, spawn one default
   *      session so the panel opens to a usable terminal rather than
   *      an empty "click + to add" prompt.
   *
   * Tracked via a ref so we don't re-run on every re-render. Re-runs
   * cleanly when projectId changes (the ref keys on projectId).
   */
  const probedProjectRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hasElectron) return;
    if (probedProjectRef.current === projectId) return;
    probedProjectRef.current = projectId;
    void (async () => {
      const initial = useTerminalSessions.getState().byProject[projectId] ?? [];
      const alive: TerminalSession[] = [];
      for (const s of initial) {
        try {
          // Resize is the cheapest probe — succeeds if PTY exists,
          // throws if PtyManager has dropped it.
          await apiCall('terminal.resize', { terminalId: s.id, cols: 80, rows: 24 });
          alive.push(s);
        } catch {
          /* drop */
        }
      }
      if (alive.length !== initial.length) {
        replaceSessions(projectId, alive);
      }
      // Autospawn if nothing survived (or there was nothing to begin with).
      if (alive.length === 0) {
        await spawnNew();
      }
    })();
    // spawnNew is stable via useCallback below; we intentionally don't
    // list it to avoid re-running the probe on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, hasElectron, replaceSessions]);

  /** Spawn a fresh PTY and add it to the store as the new active tab. */
  const spawnNew = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setSpawnError(null);
    try {
      const spawn = await apiCall<SpawnResult>('terminal.spawn', {
        target: { kind: 'project', projectId },
        cols: 80,
        rows: 24,
      });
      addSession(projectId, spawn.terminalId);
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [projectId, busy, addSession]);

  /** Close a single tab: kill PTY + drop from list. */
  const closeTab = useCallback(
    async (terminalId: string) => {
      removeSession(projectId, terminalId);
      try {
        await apiCall('terminal.kill', { terminalId });
      } catch {
        /* PTY may have already exited — silent */
      }
    },
    [projectId, removeSession],
  );

  /** Restart the active terminal: kill + spawn replacement in its slot. */
  const restartActive = useCallback(async () => {
    if (!activeId) return;
    await closeTab(activeId);
    await spawnNew();
  }, [activeId, closeTab, spawnNew]);

  if (!hasElectron) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2 p-3">
        <AlertCircle className="h-4 w-4" />
        <span>Terminal requires the Electron app — browser dev fallback not wired.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-[#0b0d12]">
      <TerminalTabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => setActive(projectId, id)}
        onClose={(id) => void closeTab(id)}
        onAdd={() => void spawnNew()}
        onRestart={() => void restartActive()}
        addDisabled={busy}
      />
      {spawnError && (
        <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">
          {spawnError}
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
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
        {/*
          Each terminal renders as its own SingleTerminal. We key on the
          session id so React fully unmounts/remounts when the active tab
          changes — the new mount re-attaches via terminal.output(id) and
          the buffer replays from scratch. That gives "instant" history
          on tab switch without the complexity of keeping multiple xterm
          instances mounted simultaneously.
        */}
        {activeId && (
          <SingleTerminal
            key={activeId}
            terminalId={activeId}
            projectId={projectId}
            onProcessExited={() => {
              // Process exited (user typed `exit`) — drop the tab so
              // the panel doesn't keep showing a dead shell. Spawn a
              // replacement only if the user explicitly clicks +.
              void closeTab(activeId);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────

interface TerminalTabBarProps {
  sessions: TerminalSession[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  onRestart: () => void;
  addDisabled: boolean;
}

function TerminalTabBar({
  sessions,
  activeId,
  onSelect,
  onClose,
  onAdd,
  onRestart,
  addDisabled,
}: TerminalTabBarProps) {
  return (
    <div className="h-7 shrink-0 border-b flex items-center px-1 gap-0.5 bg-card/50 overflow-x-auto">
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        return (
          <div
            key={s.id}
            className={cn(
              'group inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-sm text-[11px] cursor-pointer shrink-0 transition-colors',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
            onClick={() => onSelect(s.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(s.id);
              }
            }}
            title={`${s.name} · ${new Date(s.createdAt).toLocaleTimeString()}`}
          >
            <TerminalSquare
              className={cn(
                'h-3 w-3 shrink-0',
                isActive ? 'text-primary' : 'text-muted-foreground/70',
              )}
            />
            <span className="font-medium">{s.name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              className="ml-1 h-4 w-4 rounded-sm grid place-items-center hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={`Close ${s.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        disabled={addDisabled}
        className="h-6 w-6 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
        aria-label="New terminal"
        title="New terminal"
      >
        <Plus className="h-3 w-3" />
      </button>

      {/* Right-side cluster: restart active session. */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">
        {activeId && (
          <button
            type="button"
            onClick={onRestart}
            className="h-6 w-6 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            aria-label="Restart active terminal"
            title="Restart the active terminal (kills its PTY and spawns a fresh shell)"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Single terminal renderer ────────────────────────────────────
//
// Mounts an xterm.js instance bound to ONE terminalId. Subscribes to
// `terminal.output(id)` which replays the PtyManager's buffer before
// flowing live data — so a fresh mount of an existing session shows
// the user's full history immediately.
//
// The component intentionally does NOT manage spawn/kill — that's
// the container's job. Unmount only cancels the local stream + tears
// down xterm; the PTY stays alive in the backend.

interface SingleTerminalProps {
  terminalId: string;
  projectId: number;
  onProcessExited: () => void;
}

type TerminalOutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

function SingleTerminal({ terminalId, projectId, onProcessExited }: SingleTerminalProps) {
  // projectId only used for future per-project key bindings; suppress
  // unused-var lint via void without losing the prop for callers.
  void projectId;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#0b0d12',
        foreground: '#dadfea',
        cursor: '#dadfea',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    // Resize observer — fires when BottomPanel is dragged or the
    // window is resized. rAF-debounced so we don't slam the PTY with
    // resize calls during a drag.
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* detached mid-resize */ }
        if (term.cols && term.rows) {
          void apiCall('terminal.resize', { terminalId, cols: term.cols, rows: term.rows });
        }
      });
    });
    ro.observe(containerRef.current);

    // Wire keystrokes → PTY.
    const onDataDisposable = term.onData((data) => {
      void apiCall('terminal.write', { terminalId, data });
    });

    // Open the output stream. The backend subscribe() replays
    // entry.buffer to a new listener before flowing live data, so
    // the user sees their history right away when re-attaching.
    const stream = apiStream<TerminalOutputChunk>('terminal.output', { terminalId });
    const iterator = stream[Symbol.asyncIterator]();

    void (async () => {
      try {
        while (!disposed) {
          const { value, done } = await iterator.next();
          if (done) break;
          if (value.type === 'data') {
            term.write(value.data);
          } else if (value.type === 'exit') {
            term.write(`\r\n\x1b[2m[process exited code=${value.code ?? '?'}]\x1b[0m\r\n`);
            // Let the container drop this tab — keeps the panel honest
            // (no zombie shells hanging around).
            onProcessExited();
            break;
          }
        }
      } catch {
        /* stream interrupted on unmount — expected */
      }
    })();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      // Cancel local subscription but DO NOT kill the PTY. The
      // container's closeTab handler is the only path that kills.
      void iterator.return?.();
      onDataDisposable.dispose();
      term.dispose();
    };
  }, [terminalId, onProcessExited]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
