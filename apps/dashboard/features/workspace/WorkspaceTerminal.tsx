/**
 * Workspace terminal — xterm.js wired to the api-bus `terminal.*` surface
 * (no WebSocket). Spawns a PTY rooted at the project's `root_path`
 * (`target: { kind: 'project', projectId }`) and pumps stdout/stderr
 * through `apiStream('terminal.output', …)`.
 *
 * Transport semantics:
 *   - In Electron: stream frames arrive via MessagePort, zero JSON
 *     framing overhead beyond the IPC bridge.
 *   - In browser dev: apiStream's browser fallback isn't wired for
 *     `terminal.output` yet — until it is, this component shows a
 *     "Terminal requires Electron" notice instead of a broken UI.
 *
 * Reconnect/respawn: this mounts a fresh PTY each time the component
 * mounts. Unmount kills the PTY. We don't auto-reconnect — a closed
 * shell becomes a "Restart" button.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RotateCcw, AlertCircle } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiCall, apiStream, electronApi } from '../../lib/api-client.js';

interface WorkspaceTerminalProps {
  projectId: number;
}

interface SpawnResult {
  terminalId: string;
  pid: number;
  shell: string;
  cwd: string;
}

type TerminalOutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

type Status = 'idle' | 'spawning' | 'open' | 'closed' | 'error';

export function WorkspaceTerminal({ projectId }: WorkspaceTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const cancelStreamRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [restartCount, setRestartCount] = useState(0);

  const hasElectron = !!electronApi();

  useEffect(() => {
    if (!hasElectron || !containerRef.current) return;

    let disposed = false;

    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'Geist Mono, Cascadia Code, Consolas, monospace',
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
    xtermRef.current = term;
    fitRef.current = fit;

    // Resize the PTY on container size changes (Bottom panel drag,
    // window resize). Debounce via rAF — Monaco's editor.layout()
    // pattern; cheap and visually smooth.
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* container detached mid-resize */
        }
        const id = terminalIdRef.current;
        if (id && term.cols && term.rows) {
          void apiCall('terminal.resize', { terminalId: id, cols: term.cols, rows: term.rows });
        }
      });
    });
    ro.observe(containerRef.current);

    // Spawn + start the output stream.
    (async () => {
      setStatus('spawning');
      setError(null);
      try {
        const spawn = await apiCall<SpawnResult>('terminal.spawn', {
          target: { kind: 'project', projectId },
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          await apiCall('terminal.kill', { terminalId: spawn.terminalId });
          return;
        }
        terminalIdRef.current = spawn.terminalId;
        setStatus('open');

        term.onData((data) => {
          const id = terminalIdRef.current;
          if (!id) return;
          void apiCall('terminal.write', { terminalId: id, data });
        });

        const stream = apiStream<TerminalOutputChunk>('terminal.output', {
          terminalId: spawn.terminalId,
        });
        const iterator = stream[Symbol.asyncIterator]();
        cancelStreamRef.current = () => {
          void iterator.return?.();
        };
        try {
          while (!disposed) {
            const { value, done } = await iterator.next();
            if (done) break;
            if (value.type === 'data') {
              term.write(value.data);
            } else if (value.type === 'exit') {
              term.write(`\r\n\x1b[2m[process exited code=${value.code ?? '?'}]\x1b[0m\r\n`);
              setStatus('closed');
              break;
            }
          }
        } catch (err) {
          if (!disposed) {
            setStatus('error');
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } catch (err) {
        if (disposed) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      cancelStreamRef.current?.();
      cancelStreamRef.current = null;
      const id = terminalIdRef.current;
      terminalIdRef.current = null;
      if (id) {
        void apiCall('terminal.kill', { terminalId: id });
      }
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [projectId, hasElectron, restartCount]);

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
      <div className="h-7 shrink-0 border-b flex items-center justify-between px-2 gap-2 bg-card/50">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {status === 'open' && 'Terminal'}
          {status === 'spawning' && 'Starting…'}
          {status === 'closed' && 'Terminal · closed'}
          {status === 'error' && 'Terminal · error'}
          {status === 'idle' && 'Terminal'}
        </span>
        {(status === 'closed' || status === 'error') && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setRestartCount((c) => c + 1)}
            aria-label="Restart terminal"
            title="Restart"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
      {error && (
        <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10">{error}</div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 bg-[#0b0d12]" />
    </div>
  );
}
