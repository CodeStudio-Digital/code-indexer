import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, GitBranch, Loader2, Play, Square } from 'lucide-react';
import type { RunnerManager } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useGitRevision } from '../../state/git-revision.js';
import { useContributions } from '../../state/contribution-registry.js';
import { launchRun } from '../../state/run-launch.js';
import { stopTask, tasksForProject, useRunningTasks } from '../../state/running-tasks.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { BranchPopover } from '../workspace/jetbrains/status-bar/BranchPopover.js';

interface GitSummary {
  branch?: string | null;
  notARepo?: boolean;
  files?: Array<{ staged: boolean; state: string }>;
}

export function ProjectBranchControl({ projectId }: { projectId: number }) {
  const revision = useGitRevision((state) => state.revByProject[projectId] ?? 0);
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void apiCall<GitSummary>('projectGit.status', { projectId })
      .then((value) => { if (alive) setSummary(value); })
      .catch(() => { if (alive) setSummary({ notARepo: true }); });
    return () => { alive = false; };
  }, [projectId, revision, refresh]);

  if (summary?.notARepo) return null;
  const dirty = summary?.files?.some((file) => file.state !== 'ignored') ?? false;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="no-drag flex h-7 max-w-[220px] items-center gap-1.5 rounded px-2 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground"
          aria-label="Git branch"
        >
          {summary === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
          <span className="truncate">{summary?.branch ?? 'Loading branch'}</span>
          {dirty && <span className="text-amber-400">●</span>}
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="p-0 overflow-hidden">
        <BranchPopover
          projectId={projectId}
          onMutated={() => setRefresh((value) => value + 1)}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

const MANAGERS = new Set<RunnerManager>([
  'npm', 'yarn', 'pnpm', 'bun', 'composer', 'pip', 'poetry', 'gradle', 'maven',
  'dotnet', 'node', 'php', 'python', 'shell',
]);

function managerFor(command: string): RunnerManager {
  const binary = command.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.cmd$/i, '') as RunnerManager;
  return MANAGERS.has(binary) ? binary : 'shell';
}

function quoteArg(value: string): string {
  if (/^[\w./:@=-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function ProjectRunControl({ projectId }: { projectId: number }) {
  const allConfigurations = useContributions((state) => state.runConfigurations);
  // RunnerStartInput currently has no env field. Hide incompatible declarations
  // instead of presenting a control that silently runs with the wrong process env.
  const configurations = useMemo(
    () => allConfigurations.filter((config) => !config.env || Object.keys(config.env).length === 0),
    [allConfigurations],
  );
  const storageKey = `mcp-ide:run-config:${projectId}`;
  const [selectedId, setSelectedId] = useState(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const allTasks = useRunningTasks((state) => state.tasks);
  const tasks = useMemo(() => tasksForProject(allTasks, projectId), [allTasks, projectId]);
  const running = tasks.filter((task) => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
  const configKey = (config: (typeof configurations)[number]) => `${config.pluginNs}:${config.id}`;
  const selected = configurations.find((config) => configKey(config) === selectedId) ?? configurations[0];

  useEffect(() => {
    if (!selected || configKey(selected) === selectedId) return;
    setSelectedId(configKey(selected));
  }, [selected, selectedId]);

  const select = (id: string) => {
    setSelectedId(id);
    try { localStorage.setItem(storageKey, id); } catch { /* optional preference */ }
  };

  if (!selected) return null;
  const command = [selected.command, ...(selected.args ?? []).map(quoteArg)].join(' ');

  return (
    <div className="no-drag flex h-7 items-center rounded border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-full max-w-[220px] items-center gap-1.5 px-2 text-[11px] text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground"
            title={selected.description ?? selected.title}
          >
            <span className="truncate">{selected.title}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {configurations.map((config) => (
            <DropdownMenuItem key={configKey(config)} onSelect={() => select(configKey(config))}>
              <span className={cn('truncate', configKey(config) === configKey(selected) && 'font-semibold')}>{config.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-4 w-px bg-[var(--workbench-border)]" />
      {running ? (
        <button
          type="button"
          onClick={() => void stopTask(running.taskId)}
          className="grid h-full w-7 place-items-center text-red-400 hover:bg-red-500/10"
          aria-label={`Stop ${running.label}`}
          title={`Stop ${running.label}`}
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void launchRun({
            projectId,
            command,
            label: selected.title,
            manager: managerFor(selected.command),
            cwd: selected.cwd,
          })}
          className="grid h-full w-7 place-items-center text-emerald-400 hover:bg-emerald-500/10"
          aria-label={`Run ${selected.title}`}
          title={`Run ${selected.title}`}
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </button>
      )}
    </div>
  );
}
