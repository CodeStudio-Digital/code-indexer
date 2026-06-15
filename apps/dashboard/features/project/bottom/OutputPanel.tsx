/**
 * Output panel — read-only log view for the project's runner tasks (dev
 * server, build, test, …). Reuses the existing PTY plumbing: a task's
 * `terminalId` feeds `terminal.output`, the same stream the interactive
 * terminal and the preview URL detector consume.
 *
 * Read-only on purpose (`disableStdin`): this is a log surface, not a shell —
 * the Terminal tab covers interactive use. Defaults to the dev-server task.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Eraser } from 'lucide-react';
import type { RunnerTask } from '@mcp/api-bus';
import { apiStream } from '../../../lib/api-client.js';
import { useRunningTasks, tasksForProject, isDevServerTask } from '../../../state/running-tasks.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';

type OutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

interface OutputPanelProps {
  projectId: number;
}

export function OutputPanel({ projectId }: OutputPanelProps) {
  const tasks = useRunningTasks((s) => s.tasks);
  const mine = useMemo(() => tasksForProject(tasks, projectId), [tasks, projectId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default to a dev-server task; fall back to the first task. Re-resolves
  // when the chosen task disappears (stopped + dismissed).
  const selected: RunnerTask | undefined = useMemo(() => {
    const byId = selectedId ? mine.find((t) => t.taskId === selectedId) : undefined;
    return byId ?? mine.find(isDevServerTask) ?? mine[0];
  }, [mine, selectedId]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const terminalId = selected?.terminalId;

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !terminalId) return;
    let disposed = false;

    const term = new XTerm({
      fontSize: 12,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 8000,
      theme: { background: '#0b0d12', foreground: '#dadfea', cursor: '#0b0d12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    let raf: number | null = null;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { try { fit.fit(); } catch { /* detached mid-resize */ } });
    });
    ro.observe(host);

    // The backend replays the PTY buffer to a new listener before flowing
    // live data, so the panel shows existing history immediately.
    const stream = apiStream<OutputChunk>('terminal.output', { terminalId });
    const it = stream[Symbol.asyncIterator]();
    void (async () => {
      try {
        while (!disposed) {
          const { value, done } = await it.next();
          if (done) break;
          if (value.type === 'data') term.write(value.data);
          else {
            term.write(`\r\n\x1b[2m[process exited code=${value.code ?? '?'}]\x1b[0m\r\n`);
            break;
          }
        }
      } catch { /* stream interrupted on unmount — expected */ }
    })();

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      void it.return?.();
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId]);

  if (mine.length === 0) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground p-2">
        No tasks running. Start one from the Runners tab.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-7 shrink-0 border-b flex items-center gap-2 px-2">
        <select
          value={selected?.taskId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-transparent text-xs outline-none max-w-[55%] truncate"
        >
          {mine.map((t) => (
            <option key={t.taskId} value={t.taskId}>
              {(t.label || t.command)} · {t.status}
            </option>
          ))}
        </select>
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide shrink-0',
            selected?.status === 'running' ? 'text-emerald-500' : 'text-muted-foreground',
          )}
        >
          {selected?.status}
          {selected?.exitCode != null ? ` (${selected.exitCode})` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 ml-auto"
          onClick={() => termRef.current?.clear()}
          aria-label="Clear output"
          title="Clear"
        >
          <Eraser className="h-3 w-3" />
        </Button>
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
