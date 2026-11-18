/**
 * Unified project execution log. Runner PTYs, debugger/DAP sessions and
 * finite Git operations all appear here and remain selectable after they
 * finish. The surface is read-only; the Terminal tab owns interactive input.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Eraser } from 'lucide-react';
import type { DebugSessionSummary, RunnerTask } from '@mcp/api-bus';
import { apiStream } from '../../../lib/api-client.js';
import { useRunningTasks, tasksForProject } from '../../../state/running-tasks.js';
import { useDebugSessions } from '../../../state/debug-sessions.js';
import {
  debugSessionOutput,
  executionEntriesForProject,
  terminalOutputEol,
  useExecutionOutput,
  type ExecutionOutputEntry,
} from '../../../state/execution-output.js';
import { xtermTheme, TERMINAL_SURFACE_BG } from '../../shared/terminal/SingleTerminal.js';
import { installTerminalClipboard } from '../../shared/terminal/terminal-clipboard.js';
import { useIsDark } from '../../builder/preview/files/viewer/useIsDark.js';
import { Button } from '../../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { cn } from '../../../lib/utils.js';

type OutputChunk =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null; signal: string | null };

type OutputItem =
  | { kind: 'runner'; key: string; startedAt: number; task: RunnerTask }
  | { kind: 'debug'; key: string; startedAt: number; session: DebugSessionSummary }
  | { kind: 'execution'; key: string; startedAt: number; entry: ExecutionOutputEntry };

function itemTitle(item: OutputItem): string {
  if (item.kind === 'runner') return item.task.label || item.task.command;
  if (item.kind === 'debug') return item.session.name;
  return item.entry.label;
}

function itemSource(item: OutputItem): 'runner' | 'debug' | 'git' {
  if (item.kind === 'execution') return item.entry.source;
  return item.kind;
}

function itemStatus(item: OutputItem): string {
  if (item.kind === 'runner') return item.task.status;
  if (item.kind === 'debug') return item.session.state;
  return item.entry.status;
}

function itemExitCode(item: OutputItem): number | null | undefined {
  if (item.kind === 'runner') return item.task.exitCode;
  if (item.kind === 'debug') return item.session.exitCode;
  return undefined;
}

function isActiveStatus(status: string): boolean {
  return ['running', 'starting', 'initializing', 'configuring'].includes(status);
}

function isFailureStatus(status: string, exitCode: number | null | undefined): boolean {
  return status === 'failed' || status === 'error' || (typeof exitCode === 'number' && exitCode !== 0);
}

function staticOutput(item: OutputItem | undefined): string {
  if (!item || item.kind === 'runner') return '';
  return item.kind === 'debug' ? debugSessionOutput(item.session) : item.entry.output;
}

function outputTheme(dark: boolean): ReturnType<typeof xtermTheme> {
  const base = xtermTheme(dark);
  return { ...base, cursor: base.background };
}

interface OutputPanelProps {
  projectId: number;
  runnerProjectId?: number;
  worktreePath?: string | null;
}

export function OutputPanel({ projectId, runnerProjectId = projectId, worktreePath }: OutputPanelProps) {
  const { t } = useTranslation(['projects']);
  const tasks = useRunningTasks((state) => state.tasks);
  const debugSessions = useDebugSessions((state) => state.sessions);
  const executionEntries = useExecutionOutput((state) => state.entries);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = useMemo<OutputItem[]>(() => {
    const runnerItems: OutputItem[] = tasksForProject(tasks, runnerProjectId, worktreePath).map((task) => ({
      kind: 'runner',
      key: `runner:${task.taskId}`,
      startedAt: task.startedAt,
      task,
    }));
    const debugItems: OutputItem[] = debugSessions
      .filter((session) => session.projectId === projectId)
      .map((session) => ({
        kind: 'debug',
        key: `debug:${session.sessionId}`,
        startedAt: session.startedAt,
        session,
      }));
    const finiteItems: OutputItem[] = executionEntriesForProject(executionEntries, projectId).map((entry) => ({
      kind: 'execution',
      key: `execution:${entry.id}`,
      startedAt: entry.startedAt,
      entry,
    }));
    return [...runnerItems, ...debugItems, ...finiteItems].sort((a, b) => b.startedAt - a.startedAt);
  }, [tasks, debugSessions, executionEntries, projectId, runnerProjectId, worktreePath]);

  // Follow the latest execution until the user explicitly chooses history.
  // If a selected item is dismissed, fall back to the current latest item.
  const selected = items.find((item) => item.key === selectedId) ?? items[0];
  const selectedKey = selected?.key;
  const selectedStaticOutput = staticOutput(selected);
  const selectedStatus = selected ? itemStatus(selected) : '';
  const selectedExitCode = selected ? itemExitCode(selected) : undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const renderedStaticRef = useRef('');
  const dark = useIsDark();

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = outputTheme(dark);
  }, [dark]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !selected) return;
    let disposed = false;

    const term = new XTerm({
      fontSize: 12,
      fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 8000,
      theme: outputTheme(document.documentElement.classList.contains('dark')),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const disposeClipboard = installTerminalClipboard(term, host, true);
    fit.fit();
    termRef.current = term;
    renderedStaticRef.current = '';

    let raf: number | null = null;
    const resize = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* detached mid-resize */ }
      });
    });
    resize.observe(host);

    let iterator: AsyncIterator<OutputChunk> | null = null;
    if (selected.kind === 'runner') {
      const stream = apiStream<OutputChunk>('terminal.output', { terminalId: selected.task.terminalId });
      iterator = stream[Symbol.asyncIterator]();
      void (async () => {
        try {
          while (!disposed) {
            const { value, done } = await iterator!.next();
            if (done) break;
            if (value.type === 'data') term.write(value.data);
            else {
              term.write(`\r\n[process exited code=${value.code ?? '?'}]\r\n`);
              break;
            }
          }
        } catch (error) {
          if (!disposed) {
            const message = error instanceof Error ? error.message : String(error);
            term.write(`\r\n[output unavailable]\r\n${terminalOutputEol(message)}`);
          }
        }
      })();
    }

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      void iterator?.return?.();
      disposeClipboard();
      term.dispose();
      termRef.current = null;
      renderedStaticRef.current = '';
    };
    // A stable item key owns one xterm. Static content updates incrementally
    // in the effect below without tearing down the terminal or scrollback.
  }, [selectedKey]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !selected || selected.kind === 'runner') return;
    const previous = renderedStaticRef.current;
    if (selectedStaticOutput.startsWith(previous)) {
      const suffix = selectedStaticOutput.slice(previous.length);
      if (suffix) term.write(suffix);
    } else {
      term.write('\x1b[2J\x1b[H');
      term.write(selectedStaticOutput);
    }
    renderedStaticRef.current = selectedStaticOutput;
  }, [selectedKey, selectedStaticOutput, selected]);

  if (items.length === 0) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground p-2">
        {t('output.empty')}
      </div>
    );
  }

  const failed = isFailureStatus(selectedStatus, selectedExitCode);
  const statusKey = `output.status.${selectedStatus}`;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-7 shrink-0 border-b flex items-center gap-2 px-2">
        <Select value={selected?.key} onValueChange={setSelectedId}>
          <SelectTrigger className="h-6 w-72 max-w-[65%] min-w-0 px-2 py-1 text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.key} value={item.key} className="text-xs">
                {t(`output.source.${itemSource(item)}`)} · {itemTitle(item)} · {t(`output.status.${itemStatus(item)}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide shrink-0',
            failed
              ? 'text-red-500'
              : isActiveStatus(selectedStatus)
                ? 'text-emerald-500'
                : selectedStatus === 'paused'
                  ? 'text-amber-500'
                  : 'text-muted-foreground',
          )}
        >
          {t(statusKey)}
          {selectedExitCode != null ? ` (${selectedExitCode})` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 ml-auto"
          onClick={() => termRef.current?.clear()}
          aria-label={t('output.clear')}
          title={t('output.clear')}
        >
          <Eraser className="h-3 w-3" />
        </Button>
      </div>
      <div
        className="relative flex-1 min-h-0"
        style={{ background: dark ? TERMINAL_SURFACE_BG.dark : TERMINAL_SURFACE_BG.light }}
      >
        <div ref={containerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
