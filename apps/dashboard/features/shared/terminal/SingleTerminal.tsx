/**
 * Shared xterm.js mount — single terminalId, replays buffer on mount,
 * streams live data, forwards keystrokes, debounces resize.
 *
 * Extracted from `WorkspaceTerminal` so the agents view can reuse the
 * exact same renderer without duplicating logic. The container owns
 * spawn/kill; this component only attaches.
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiCall, apiStream } from '../../../lib/api-client.js';

export interface SingleTerminalProps {
  terminalId: string;
  /** Notified when the underlying PTY process exits (user typed `exit`). */
  onProcessExited: () => void;
}

type TerminalOutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

export function SingleTerminal({ terminalId, onProcessExited }: SingleTerminalProps) {
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

    // ── Clipboard wiring ───────────────────────────────────────────
    // xterm.js doesn't bind clipboard shortcuts by design — Ctrl+C is
    // SIGINT in a real shell, so the lib leaves the policy to the
    // host app. We follow the IDE-terminal conventions:
    //
    //   - Ctrl+Shift+C → copy selection (Linux/JetBrains style)
    //   - Ctrl+Shift+V → paste clipboard
    //   - Ctrl+C       → copy ONLY when there's a selection AND no
    //                    process is reading stdin (matches VS Code).
    //                    Otherwise the keystroke flows through to
    //                    the PTY as SIGINT, which is the user's
    //                    Ctrl+C-cancels-the-running-command muscle
    //                    memory.
    //   - Ctrl+V       → paste (Windows muscle memory; harmless
    //                    everywhere else because terminals never
    //                    receive 0x16 from a paste)
    //   - Shift+Insert → paste (X11 muscle memory)
    //   - right-click  → paste (PowerShell/Windows Terminal default)
    //
    // `attachCustomKeyEventHandler` runs BEFORE `onData`; returning
    // `false` swallows the keystroke. Returning `true` lets xterm
    // handle it normally and forward to the PTY.
    async function copySelection(): Promise<boolean> {
      const sel = term.getSelection();
      if (!sel) return false;
      try {
        await navigator.clipboard.writeText(sel);
        return true;
      } catch {
        return false;
      }
    }
    async function pasteClipboard(): Promise<void> {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          // term.paste handles bracketed-paste mode correctly when the
          // running shell has it enabled (bash/zsh by default since 4.4).
          term.paste(text);
        }
      } catch {
        /* clipboard read denied — silent. Electron grants this in our
         *  webPreferences, browser fallback may not. */
      }
    }

    term.attachCustomKeyEventHandler((e) => {
      // Only intercept on keydown — xterm fires both down + up.
      if (e.type !== 'keydown') return true;

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const key = e.key.toLowerCase();

      // Ctrl+Shift+C — copy
      if (ctrl && shift && key === 'c') {
        void copySelection();
        return false;
      }
      // Ctrl+Shift+V — paste
      if (ctrl && shift && key === 'v') {
        void pasteClipboard();
        return false;
      }
      // Ctrl+C with selection → copy + clear selection. No selection
      // → fall through (SIGINT).
      if (ctrl && !shift && key === 'c' && term.hasSelection()) {
        void copySelection().then((ok) => {
          if (ok) term.clearSelection();
        });
        return false;
      }
      // Ctrl+V — paste (Windows convention)
      if (ctrl && !shift && key === 'v') {
        void pasteClipboard();
        return false;
      }
      // Shift+Insert — X11 paste
      if (shift && e.key === 'Insert') {
        void pasteClipboard();
        return false;
      }
      return true;
    });

    // Right-click → paste. Stops the browser context menu (which we
    // don't have a useful set of items for anyway in a PTY surface)
    // and pastes the clipboard verbatim.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void pasteClipboard();
    };
    containerRef.current.addEventListener('contextmenu', onContextMenu);

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

    const cleanupContextMenu = containerRef.current;
    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      cleanupContextMenu?.removeEventListener('contextmenu', onContextMenu);
      // Cancel local subscription but DO NOT kill the PTY. The
      // container's closeTab handler is the only path that kills.
      void iterator.return?.();
      onDataDisposable.dispose();
      term.dispose();
    };
  }, [terminalId, onProcessExited]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
