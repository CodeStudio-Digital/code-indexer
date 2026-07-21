/**
 * Shared xterm.js mount — single terminalId, replays buffer on mount,
 * streams live data, forwards keystrokes, debounces resize.
 *
 * Extracted from `WorkspaceTerminal` so the agents view can reuse the
 * exact same renderer without duplicating logic. The container owns
 * spawn/kill; this component only attaches.
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { apiCall, apiStream } from '../../../lib/api-client.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';
import { findTerminalPathMatches } from './terminal-links.js';

export interface SingleTerminalProps {
  terminalId: string;
  /** Notified when the underlying PTY process exits (user typed `exit`). */
  onProcessExited: () => void;
  /**
   * When provided, project-relative paths in the output (with optional
   * `:line:col`) become clickable links routed here. Omitted by callers with
   * no editor to open into (e.g. the agents view).
   */
  onOpenPath?: (path: string, line?: number, column?: number) => void;
}

/**
 * Terminal surface background per theme. Exported so the container
 * (empty-state region + panel) paints the exact same colour as the
 * xterm canvas — otherwise a seam shows around the terminal in light
 * mode. Kept in sync with `xtermTheme()` below.
 */
export const TERMINAL_SURFACE_BG = { dark: '#0b0d12', light: '#ffffff' } as const;

/**
 * xterm palette per app theme. The dark palette is xterm's defaults plus
 * our brand background; the light palette is a GitHub-light ANSI set that
 * stays legible on white (xterm's dark-tuned defaults wash out there).
 * Exported so other xterm surfaces (Output, Runners) share one source of truth.
 */
export function xtermTheme(dark: boolean): ITheme {
  if (dark) {
    return {
      background: TERMINAL_SURFACE_BG.dark,
      foreground: '#dadfea',
      cursor: '#dadfea',
    };
  }
  return {
    background: TERMINAL_SURFACE_BG.light,
    foreground: '#24292e',
    cursor: '#24292e',
    cursorAccent: '#ffffff',
    selectionBackground: '#0b0d1226',
    black: '#24292e',
    red: '#d73a49',
    green: '#22863a',
    yellow: '#b08800',
    blue: '#005cc5',
    magenta: '#6f42c1',
    cyan: '#1b7c83',
    white: '#6a737d',
    brightBlack: '#959da5',
    brightRed: '#cb2431',
    brightGreen: '#28a745',
    brightYellow: '#dbab09',
    brightBlue: '#2188ff',
    brightMagenta: '#8a63d2',
    brightCyan: '#3192aa',
    brightWhite: '#24292e',
  };
}

type TerminalOutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

export function SingleTerminal({ terminalId, onProcessExited, onOpenPath }: SingleTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const dark = useIsDark();

  // Latest-callback ref: keep `onProcessExited` reachable WITHOUT listing it as
  // an effect dep. A parent that passes a fresh inline callback on every render
  // (the common case) would otherwise re-run the construction effect, disposing
  // the xterm and wiping its scrollback. This is load-bearing now that a snippet
  // tab STAYS open after exit — markExited re-renders the parent, and a remount
  // here would blank the very log the user wanted to read.
  const onExitedRef = useRef(onProcessExited);
  onExitedRef.current = onProcessExited;
  // Same latest-ref trick for the (usually inline) open-path callback.
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;

  // Re-apply the xterm theme live when the user flips light/dark — the
  // terminal is NOT rebuilt (that would wipe the scrollback), only its
  // palette is swapped. The construction effect below sets the initial
  // theme from the DOM, so this is a no-op on first mount.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(dark);
  }, [dark]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let terminalMissing = false;

    const handleTerminalRpcError = (error: unknown) => {
      if (disposed) return;
      if ((error as { code?: string })?.code === 'not_found') {
        if (terminalMissing) return;
        terminalMissing = true;
        onExitedRef.current();
        return;
      }
      console.error('[terminal] PTY request failed:', error);
    };

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      // Read the live theme from the DOM (not the `dark` prop) so the very
      // first paint is correct without listing `dark` as an effect dep —
      // we don't want a theme flip to tear down + rebuild the terminal.
      theme: xtermTheme(document.documentElement.classList.contains('dark')),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    // Clickable file links: project-relative paths (+ optional :line:col) in the
    // output open in the editor. Registered only when the host wired a handler.
    const linkProvider = onOpenPathRef.current
      ? term.registerLinkProvider({
          provideLinks(bufferLineNumber, callback) {
            const lineText = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
            const matches = lineText ? findTerminalPathMatches(lineText) : [];
            if (matches.length === 0) { callback(undefined); return; }
            callback(matches.map((mm) => ({
              range: { start: { x: mm.startX + 1, y: bufferLineNumber }, end: { x: mm.endX, y: bufferLineNumber } },
              text: lineText!.slice(mm.startX, mm.endX),
              activate: () => onOpenPathRef.current?.(mm.path, mm.line, mm.column),
            })));
          },
        })
      : null;

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
          void apiCall('terminal.resize', { terminalId, cols: term.cols, rows: term.rows }).catch(handleTerminalRpcError);
        }
      });
    });
    ro.observe(containerRef.current);

    // Wire keystrokes → PTY.
    const onDataDisposable = term.onData((data) => {
      void apiCall('terminal.write', { terminalId, data }).catch((error) => {
        // A renderer can outlive its main-process PTY after a dev reload or a
        // process exit. Treat the authoritative 404 as an exit instead of
        // leaking an unhandled rejection into DevTools on the next keystroke.
        handleTerminalRpcError(error);
      });
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
            // Notify the container (close an interactive shell / keep a snippet
            // tab). Via ref so a changing callback never remounts this terminal.
            onExitedRef.current();
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
      linkProvider?.dispose();
      term.dispose();
      termRef.current = null;
    };
    // NB: `onProcessExited` is intentionally NOT a dep — it's read via
    // onExitedRef so a parent re-render (e.g. markExited) doesn't rebuild xterm.
  }, [terminalId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
