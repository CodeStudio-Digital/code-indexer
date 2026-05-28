import { useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Circle, Loader2, ListChecks } from 'lucide-react';
import type { TaskRunState, TaskRunTask, Usage } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';

interface TaskExecutionBlockProps {
  run: TaskRunState;
  defaultOpen?: boolean;
}

export function TaskExecutionBlock({ run, defaultOpen }: TaskExecutionBlockProps) {
  const [open, setOpen] = useState(defaultOpen ?? run.status === 'running');
  const isRunning = run.status === 'running';
  const completed = run.tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length;
  const failed = run.tasks.filter((task) => task.status === 'failed' || task.status === 'interrupted').length;
  const totalTools = run.tasks.reduce((sum, task) => sum + task.toolCallCount, 0);
  const totalTokens = usageTokens(run.totalUsage);

  const tasksByWave = useMemo(() => {
    const groups = new Map<number, TaskRunTask[]>();
    for (const task of run.tasks) {
      const list = groups.get(task.wave) ?? [];
      list.push(task);
      groups.set(task.wave, list);
    }
    return Array.from(groups, ([wave, tasks]) => ({ wave, tasks }))
      .sort((a, b) => a.wave - b.wave);
  }, [run.tasks]);

  return (
    <div className="my-2 rounded-lg border bg-muted/30 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-muted/60 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <div
          className={cn(
            'h-5 w-5 rounded-md flex items-center justify-center shrink-0',
            run.status === 'failed'
              ? 'text-destructive bg-destructive/10'
              : isRunning
                ? 'text-warning bg-warning/10'
                : 'text-success bg-success/10',
          )}
        >
          {run.status === 'failed' ? (
            <AlertCircle className="h-3 w-3" />
          ) : isRunning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </div>
        <ListChecks className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium text-foreground">execute_tasks</span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {completed}/{run.totalTasks}
        </Badge>
        {failed > 0 && (
          <Badge variant="destructive" className="shrink-0 tabular-nums">
            {failed} failed
          </Badge>
        )}
        <Badge variant="secondary" className="shrink-0">
          {run.mode}
        </Badge>
        <span className="ml-auto text-muted-foreground tabular-nums shrink-0">
          {run.waves.length} wave{run.waves.length === 1 ? '' : 's'} · {totalTools} tool{totalTools === 1 ? '' : 's'}
          {totalTokens > 0 ? ` · ${formatTokens(totalTokens)} tok` : ''}
        </span>
      </button>

      {open && (
        <div className="border-t bg-background/40">
          {tasksByWave.map(({ wave, tasks }) => (
            <div key={wave} className="border-b last:border-b-0">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/20">
                Wave {wave}
              </div>
              {tasks.map((task) => (
                <TaskRunRow key={task.id} task={task} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRunRow({ task }: { task: TaskRunTask }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!task.summary || !!task.error;
  const StatusIcon = task.status === 'running'
    ? Loader2
    : task.status === 'done' || task.status === 'skipped'
      ? Check
      : task.status === 'failed' || task.status === 'interrupted'
        ? AlertCircle
        : Circle;
  const statusColor =
    task.status === 'failed' || task.status === 'interrupted'
      ? 'text-destructive bg-destructive/10'
      : task.status === 'running'
        ? 'text-warning bg-warning/10'
        : task.status === 'done' || task.status === 'skipped'
          ? 'text-success bg-success/10'
          : 'text-muted-foreground bg-muted';

  return (
    <div className="border-t first:border-t-0">
      <button
        type="button"
        onClick={hasDetails ? () => setOpen((value) => !value) : undefined}
        className={cn(
          'w-full px-3 py-2 flex items-center gap-2 text-left transition-colors',
          hasDetails && 'hover:bg-muted/50 cursor-pointer',
          !hasDetails && 'cursor-default',
        )}
      >
        {hasDetails ? (
          <ChevronRight
            className={cn(
              'h-3 w-3 text-muted-foreground transition-transform shrink-0',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className={cn('h-4 w-4 rounded flex items-center justify-center shrink-0', statusColor)}>
          <StatusIcon className={cn('h-2.5 w-2.5', task.status === 'running' && 'animate-spin')} />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground shrink-0">{task.id}</span>
        <span className="text-foreground truncate">{task.title}</span>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {task.kind}
        </Badge>
        <Badge variant="secondary" className="text-[10px] shrink-0">
          {task.mode}
        </Badge>
        <span className="ml-auto text-muted-foreground tabular-nums shrink-0 text-[10px]">
          {task.toolCallCount} tool{task.toolCallCount === 1 ? '' : 's'}
          {usageTokens(task.usage) > 0 ? ` · ${formatTokens(usageTokens(task.usage))}` : ''}
        </span>
      </button>
      {task.status === 'running' && task.progressNote && (
        <div className="px-8 pb-2 text-[11px] text-warning space-y-1">
          <div>{task.progressNote}</div>
          <TaskRunMeta task={task} />
        </div>
      )}
      {open && hasDetails && (
        <div className="px-8 pb-3 pt-1 bg-background/50">
          {task.error ? (
            <div className="space-y-2">
              <pre className="font-mono text-[11px] text-destructive whitespace-pre-wrap break-words">
                {task.error}
              </pre>
              <TaskRunMeta task={task} />
            </div>
          ) : (
            <div className="text-[11px] text-foreground/80">
              <Markdown text={task.summary ?? ''} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRunMeta({ task }: { task: TaskRunTask }) {
  const parts: string[] = [];
  if (task.phase) parts.push(task.phase);
  if (task.lastToolName) parts.push(`last ${task.lastToolName}`);
  if (task.turn != null && task.turn > 0) parts.push(`turn ${task.turn}`);
  if (task.elapsedMs != null && task.elapsedMs > 0) parts.push(`elapsed ${formatDuration(task.elapsedMs)}`);
  if (task.stallMs != null && task.stallMs > 0) parts.push(`idle ${formatDuration(task.stallMs)}`);
  if (task.limit?.maxToolCalls) parts.push(`cap ${task.limit.maxToolCalls} tools`);
  if (task.limit?.timeoutMs) parts.push(`timeout ${formatDuration(task.limit.timeoutMs)}`);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
      {parts.map((part) => (
        <span key={part} className="font-mono">{part}</span>
      ))}
    </div>
  );
}

export function parseExecuteTasksResult(content: string): TaskRunState | null {
  const header = content.match(/^\[execute_tasks:\s+(\d+)\s+wave\(s\),\s+(\d+)\s+task\(s\),\s+input=(\d+)\s+output=(\d+)\]/);
  if (!header) return null;
  const sections = content.slice(header[0].length).trim().split(/\n\n---\n\n/g).filter(Boolean);
  const tasks: TaskRunTask[] = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    const match = section.match(/^###\s+(.+?)\s+(?:—|-)\s+(.+?)\s+\[([^\]]+)\]\s*\n([\s\S]*)$/);
    if (!match) continue;
    const meta = parseMeta(match[3]);
    const kind = normalizeKind(meta.kind ?? meta.positional[0]);
    const status = normalizeStatus(meta.status ?? meta.positional[1]);
    const wave = readInt(meta.wave) ?? i + 1;
    const tools = readInt(meta.tools) ?? 0;
    const tokens = readInt(meta.tokens) ?? 0;
    const summary = match[4].trim();
    tasks.push({
      id: match[1].trim(),
      title: match[2].trim(),
      kind,
      wave,
      mode: 'subagent',
      status,
      toolCallCount: tools,
      summary,
      error: status === 'failed' ? summary : undefined,
      usage: tokens > 0 ? { input_tokens: tokens, output_tokens: 0 } : undefined,
    });
  }
  if (tasks.length === 0) return null;
  const waveMap = new Map<number, string[]>();
  for (const task of tasks) {
    const ids = waveMap.get(task.wave) ?? [];
    ids.push(task.id);
    waveMap.set(task.wave, ids);
  }
  return {
    runId: 'persisted-execute-tasks',
    mode: 'auto',
    status: tasks.some((task) => task.status === 'failed' || task.status === 'interrupted') ? 'failed' : 'completed',
    totalTasks: tasks.length,
    waves: Array.from(waveMap, ([index, taskIds]) => ({ index, taskIds })).sort((a, b) => a.index - b.index),
    tasks,
    totalUsage: {
      input_tokens: Number(header[3] ?? 0),
      output_tokens: Number(header[4] ?? 0),
    },
  };
}

function parseMeta(raw: string): Record<string, string> & { positional: string[] } {
  const meta: Record<string, string> & { positional: string[] } = { positional: [] };
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      meta[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    } else if (trimmed) {
      meta.positional.push(trimmed);
    }
  }
  return meta;
}

function normalizeKind(raw: string | undefined): TaskRunTask['kind'] {
  return raw === 'investigate' || raw === 'verify' ? raw : 'implement';
}

function normalizeStatus(raw: string | undefined): TaskRunTask['status'] {
  if (raw === 'done' || raw === 'failed' || raw === 'skipped' || raw === 'interrupted' || raw === 'running') {
    return raw;
  }
  return 'done';
}

function readInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function usageTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}
