/**
 * Global "running tasks" indicator for the AppShell topbar. Shows a badge
 * with the count of currently-running runner tasks and a dropdown that
 * lists every run across all projects, grouped by project, with a Stop
 * control and a click-through to the project's Runners tab.
 *
 * Reads from the `useRunningTasks` store (fed by the `runner.events`
 * stream). Mounted in the application header.
 */

import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Play, Square, Loader2, X } from 'lucide-react';
import { Button } from './ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import type { RunnerTask } from '@mcp/api-bus';
import { useRunningTasks, runningCount, stopTask, dismissTask } from '../state/running-tasks.js';
import { cn } from '../lib/utils.js';

function groupByProject(tasks: RunnerTask[]): Array<{ projectId: number; name: string; tasks: RunnerTask[] }> {
  const map = new Map<number, { projectId: number; name: string; tasks: RunnerTask[] }>();
  for (const t of tasks) {
    let g = map.get(t.projectId);
    if (!g) {
      g = { projectId: t.projectId, name: t.projectName, tasks: [] };
      map.set(t.projectId, g);
    }
    g.tasks.push(t);
  }
  return [...map.values()];
}

function StatusDot({ status }: { status: RunnerTask['status'] }) {
  if (status === 'running') return <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />;
  const color = status === 'exited' ? 'bg-muted-foreground' : 'bg-amber-500';
  return <span className={cn('h-1.5 w-1.5 rounded-full', color)} aria-hidden />;
}

export function RunningTasksDropdown() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tasks = useRunningTasks((s) => s.tasks);
  const count = runningCount(tasks);
  const groups = groupByProject(tasks);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 relative"
              aria-label={t('runningTasks.tooltip')}
            >
              <Play className="h-3.5 w-3.5" />
              {count > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-emerald-500 text-[9px] font-semibold text-white grid place-items-center">
                  {count}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('runningTasks.tooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('runningTasks.label')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {groups.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('runningTasks.empty')}</div>
        )}
        {groups.map((g) => (
          <div key={g.projectId} className="px-1 py-1">
            <button
              type="button"
              onClick={() => navigate(`/projects/${g.projectId}?tab=runners`)}
              className="w-full text-left px-1 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground truncate"
            >
              {g.name}
            </button>
            {g.tasks.map((task) => (
              <div
                key={task.taskId}
                className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/60"
              >
                <StatusDot status={task.status} />
                <button
                  type="button"
                    onClick={() => {
                      const search = new URLSearchParams({ tab: 'runners', worktree: task.worktreePath ?? '' });
                      navigate(`/projects/${task.projectId}?${search}`);
                    }}
                  className="flex-1 min-w-0 text-left"
                >
                  <span className="block text-xs font-medium truncate">{task.label}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{task.command}</span>
                </button>
                {task.status === 'running' ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-400"
                    aria-label={t('runningTasks.stop')}
                    onClick={() => void stopTask(task.taskId)}
                  >
                    <Square className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-400"
                    aria-label={t('runningTasks.dismiss')}
                    onClick={() => void dismissTask(task.taskId)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
