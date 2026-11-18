import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug, ChevronDown, GitBranch, Loader2, Play, Square } from 'lucide-react';
import type { DetectedRunners, RunnerManager } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useGitRevision } from '../../state/git-revision.js';
import { useContributions } from '../../state/contribution-registry.js';
import { launchRun } from '../../state/run-launch.js';
import { stopTask, tasksForProject, useRunningTasks } from '../../state/running-tasks.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import {
  activeDebugSessionForProject,
  startDebugSession,
  stopDebugSession,
  useDebugSessions,
} from '../../state/debug-sessions.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import { BranchPopover } from '../workspace/jetbrains/status-bar/BranchPopover.js';
import { registerCommandHandlers } from '../../keymap/commands.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { debugBreakpointsForProject } from '../../state/debug-breakpoints.js';

interface GitSummary {
  branch?: string | null;
  notARepo?: boolean;
  files?: Array<{ staged: boolean; state: string }>;
}

export function ProjectBranchControl({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
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
          aria-label={t('toolbar.gitBranch')}
        >
          {summary === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
          <span className="truncate">{summary?.branch ?? t('toolbar.loadingBranch')}</span>
          {dirty && <span className="text-amber-400">●</span>}
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="p-0 overflow-hidden">
        <BranchPopover
          projectId={projectId}
          onMutated={() => setRefresh((value) => value + 1)}
          onRequestCommit={() => {
            const layout = useWorkspaceLayout.getState();
            layout.setPrimarySurface('editor');
            layout.setActiveLeft('git');
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

const MANAGERS = new Set<RunnerManager>([
  'npm', 'yarn', 'pnpm', 'bun', 'composer', 'pip', 'poetry', 'gradle', 'maven',
  'dotnet', 'node', 'php', 'python', 'shell',
  'java',
]);

function managerFor(command: string): RunnerManager {
  const binary = command.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.cmd$/i, '') as RunnerManager;
  return MANAGERS.has(binary) ? binary : 'shell';
}

function quoteArg(value: string): string {
  if (/^[\w./:@=-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function ProjectRunControl({ projectId, runnerProjectId = projectId, worktreePath }: {
  projectId: number;
  runnerProjectId?: number;
  worktreePath?: string | null;
}) {
  const { t } = useTranslation('projects');
  const allConfigurations = useContributions((state) => state.runConfigurations);
  // RunnerStartInput currently has no env field. Hide incompatible declarations
  // instead of presenting a control that silently runs with the wrong process env.
  const pluginConfigurations = useMemo(
    () => allConfigurations
      .filter((config) => !config.env || Object.keys(config.env).length === 0)
      .map((config) => ({
        key: `${config.pluginNs}:${config.id}`,
        title: config.title,
        description: config.description,
        command: [config.command, ...(config.args ?? []).map(quoteArg)].join(' '),
        manager: managerFor(config.command),
        cwd: config.cwd,
        debugRunner: {
          manager: managerFor(config.command),
          executable: config.command,
          args: config.args,
          command: [config.command, ...(config.args ?? []).map(quoteArg)].join(' '),
          cwd: config.cwd,
          env: config.env,
        },
        source: 'plugin' as const,
      })),
    [allConfigurations],
  );
  const [detected, setDetected] = useState<DetectedRunners | null>(null);
  useEffect(() => {
    let alive = true;
    void apiCall<DetectedRunners>('runner.detect', { projectId })
      .then((value) => { if (alive) setDetected(value); })
      .catch(() => { if (alive) setDetected(null); });
    return () => { alive = false; };
  }, [projectId]);
  const detectedConfigurations = useMemo(() => (detected?.groups ?? []).flatMap((group) =>
    group.runners.map((runner) => ({
      key: `detected:${runner.id}`,
      title: runner.label,
      description: `${group.manager} · ${group.source}`,
      command: runner.command,
      manager: runner.manager,
      cwd: group.cwd,
      debugRunner: {
        manager: runner.manager,
        script: runner.id.includes(':') ? runner.id.slice(runner.id.indexOf(':') + 1) : runner.label,
        command: runner.command,
        cwd: group.cwd,
      },
      source: 'detected' as const,
    }))), [detected]);
  const configurations = useMemo(
    () => [...pluginConfigurations, ...detectedConfigurations],
    [pluginConfigurations, detectedConfigurations],
  );
  const storageKey = `mcp-ide:run-config:${projectId}`;
  const [selection, setSelection] = useState(() => {
    try { return { projectId, id: localStorage.getItem(storageKey) }; } catch { return { projectId, id: null }; }
  });
  const selectedId = selection.projectId === projectId ? selection.id : null;
  const allTasks = useRunningTasks((state) => state.tasks);
  const debugSessions = useDebugSessions((state) => state.sessions);
  const [debugStarting, setDebugStarting] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const tasks = useMemo(() => tasksForProject(allTasks, runnerProjectId, worktreePath), [allTasks, runnerProjectId, worktreePath]);
  const running = tasks.filter((task) => task.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
  const activeDebug = activeDebugSessionForProject(debugSessions, projectId);
  const selected = configurations.find((config) => config.key === selectedId) ?? configurations[0];
  const javascriptDebuggable = selected
    ? ['node', 'npm', 'pnpm', 'yarn', 'bun'].includes(selected.manager)
    : false;

  const launchSelectedDebug = () => {
    if (!selected || !javascriptDebuggable || debugStarting || activeDebug) return;
    setDebugStarting(true);
    setDebugError(null);
    // Debug sessions publish stdout/stderr and startup diagnostics to the
    // unified Output panel, including failures before a connection is made.
    useWorkspaceLayout.getState().setActiveBottom('output');
    void startDebugSession({
      projectId,
      adapterId: 'javascript',
      request: 'launch',
      name: `Debug ${selected.title}`,
      runner: selected.debugRunner,
      breakpoints: debugBreakpointsForProject(projectId),
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setDebugError(message);
      toast.error(t('output.debugStartFailed'), { description: message });
    }).finally(() => setDebugStarting(false));
  };

  useEffect(() => registerCommandHandlers([{
    id: 'debug.selected',
    run: launchSelectedDebug,
  }]), [projectId, selected?.key, javascriptDebuggable, debugStarting, activeDebug?.sessionId]);

  useEffect(() => {
    if (selection.projectId !== projectId || !selected || selected.key === selectedId) return;
    setSelection({ projectId, id: selected.key });
    try { localStorage.setItem(storageKey, selected.key); } catch { /* optional preference */ }
  }, [projectId, selected, selectedId, selection.projectId, storageKey]);

  useEffect(() => {
    try { setSelection({ projectId, id: localStorage.getItem(storageKey) }); } catch { setSelection({ projectId, id: null }); }
  }, [projectId, storageKey]);

  const select = (id: string) => {
    setSelection({ projectId, id });
    try { localStorage.setItem(storageKey, id); } catch { /* optional preference */ }
  };

  if (!selected) return null;

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
          {pluginConfigurations.length > 0 && <DropdownMenuLabel>{t('runners.pluginConfigurations')}</DropdownMenuLabel>}
          {pluginConfigurations.map((config) => (
            <DropdownMenuItem key={config.key} onSelect={() => select(config.key)}>
              <span className={cn('truncate', config.key === selected.key && 'font-semibold')}>{config.title}</span>
            </DropdownMenuItem>
          ))}
          {pluginConfigurations.length > 0 && detectedConfigurations.length > 0 && <DropdownMenuSeparator />}
          {detectedConfigurations.length > 0 && <DropdownMenuLabel>{t('runners.detectedConfigurations')} · {detected?.groups.map((group) => group.manager).join(', ')}</DropdownMenuLabel>}
          {detectedConfigurations.map((config) => (
            <DropdownMenuItem key={config.key} onSelect={() => select(config.key)}>
              <span className={cn('truncate', config.key === selected.key && 'font-semibold')}>{config.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="h-4 w-px bg-[var(--workbench-border)]" />
      {running || activeDebug ? (
        <button
          type="button"
          onClick={() => void (activeDebug ? stopDebugSession(activeDebug.sessionId) : stopTask(running!.taskId))}
          className="grid h-full w-7 place-items-center text-red-400 hover:bg-red-500/10"
          aria-label={`Stop ${activeDebug?.name ?? running?.label ?? selected.title}`}
          title={`Stop ${activeDebug?.name ?? running?.label ?? selected.title}`}
        >
          <Square className="h-3.5 w-3.5 fill-current" />
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void launchRun({
              projectId,
              command: selected.command,
              label: selected.title,
              manager: selected.manager,
              cwd: selected.cwd,
            })}
            className="grid h-full w-7 place-items-center text-emerald-400 hover:bg-emerald-500/10"
            aria-label={`Run ${selected.title}`}
            title={`Run ${selected.title}`}
          >
            <Play className="h-3.5 w-3.5 fill-current" />
          </button>
          {javascriptDebuggable && (
            <button
              type="button"
              disabled={debugStarting}
              onClick={launchSelectedDebug}
              className="grid h-full w-7 place-items-center text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
              aria-label={`Debug ${selected.title}`}
              title={debugError ?? `Debug ${selected.title} (Shift+F9)`}
            >
              {debugStarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bug className="h-3.5 w-3.5" />}
            </button>
          )}
        </>
      )}
    </div>
  );
}
