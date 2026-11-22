import { useSessionStateSummary, type TaskRow } from './useSessionStateSummary.js';
import { useTranslation } from 'react-i18next';
import { ListChecks } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface SessionStateBannerProps {
  sessionId: string;
  refreshKey?: number;
  onActiveTaskChange?: (taskId: string | null) => void;
}

export function SessionStateBanner({ sessionId, refreshKey, onActiveTaskChange }: SessionStateBannerProps) {
  const { t } = useTranslation(['chat', 'common']);
  const data = useSessionStateSummary(sessionId, refreshKey, onActiveTaskChange);

  if (!data) return null;
  const { tasks } = data;
  if (!tasks) return null;

  const activeTask = tasks?.tasks.find((t) => t.id === tasks.current_task_id) ?? null;
  const taskCounts = tasks ? countByStatus(tasks.tasks) : null;

  return (
    <div className="border-b bg-muted/30 px-3 sm:px-5 py-2 flex flex-col gap-1.5 text-xs">
      {tasks && (
        <div className="flex items-start gap-2">
          <ListChecks className="h-3.5 w-3.5 shrink-0 mt-0.5 text-info" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                {t('chat:state.tasksLabel')}
              </span>
              {!tasks.approved && (
                <span className="px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[10px] font-medium">
                  {t('chat:state.tasksAwaiting')}
                </span>
              )}
              {taskCounts && (
                <span className="text-muted-foreground">
                  {t('chat:state.tasksCounts', taskCounts)}
                </span>
              )}
              {tasks.execution_mode && (
                <span className="text-muted-foreground">
                  {t('chat:state.tasksMode', { mode: tasks.execution_mode })}
                </span>
              )}
            </div>
            <div className="text-foreground truncate" title={tasks.summary}>{tasks.summary}</div>
            {activeTask && (
              <div className="flex items-center gap-1.5 text-info">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
                <span className="truncate" title={activeTask.title}>
                  {t('chat:state.tasksRunning', { title: activeTask.title })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function countByStatus(tasks: TaskRow[]): Record<string, number> {
  const out: Record<string, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    interrupted: 0,
  };
  for (const t of tasks) {
    const k = t.status === 'done' ? 'completed' : t.status in out ? t.status : 'pending';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
