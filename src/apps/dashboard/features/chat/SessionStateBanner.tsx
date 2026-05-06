import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Target, ListChecks } from 'lucide-react';
import { cn } from '../../lib/utils.js';

/**
 * Session-level state header. Surfaces:
 *   - Goal (if create_goal was called) — text + status pip
 *   - Active task list (if submit_tasks was approved) — current task title
 *
 * Both are read from a single endpoint `/api/coder/sessions/:id/state-summary`
 * on mount and when `sessionId` changes. The values come from DB so they
 * survive runner restarts and dashboard reloads — the original gripe was
 * that stream-only state evaporates on session switch.
 *
 * Component renders nothing when both fields are null. No live updates
 * via SSE: the user sees the latest persisted state on entry; subsequent
 * stream events update the chat below as usual, and revisiting the
 * session re-fetches.
 */
interface GoalSummary {
  text: string;
  status: 'in_progress' | 'complete';
  budget_tokens: number | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  files: string[];
}

interface TasksSummary {
  summary: string;
  approved: boolean;
  execution_mode: string | null;
  current_task_id: string | null;
  tasks: TaskRow[];
}

interface StateSummary {
  goal: GoalSummary | null;
  tasks: TasksSummary | null;
}

interface SessionStateBannerProps {
  sessionId: number;
  /**
   * Bumped by the parent to force a re-fetch when an SSE event likely
   * mutated the goal/tasks state (`goal_updated`, `tasks_resolved`, …).
   * Optional — the banner re-fetches on session change regardless.
   */
  refreshKey?: number;
  /** Fired when a task transitions to status 'running' so the parent
   *  can scroll the chat to the live execute_task block. Optional. */
  onActiveTaskChange?: (taskId: string | null) => void;
}

export function SessionStateBanner({ sessionId, refreshKey, onActiveTaskChange }: SessionStateBannerProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [data, setData] = useState<StateSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/coder/sessions/${sessionId}/state-summary`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((d: StateSummary) => {
        if (!cancelled) {
          setData(d);
          if (onActiveTaskChange) onActiveTaskChange(d.tasks?.current_task_id ?? null);
        }
      })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey, onActiveTaskChange]);

  if (!data) return null;
  const { goal, tasks } = data;
  if (!goal && !tasks) return null;

  const activeTask = tasks?.tasks.find((t) => t.id === tasks.current_task_id) ?? null;
  const taskCounts = tasks ? countByStatus(tasks.tasks) : null;

  return (
    <div className="border-b bg-muted/30 px-3 sm:px-5 py-2 flex flex-col gap-1.5 text-xs">
      {goal && (
        <div className="flex items-start gap-2">
          <Target className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', goal.status === 'complete' ? 'text-success' : 'text-warning')} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                {t('chat:state.goalLabel')}
              </span>
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] font-medium',
                  goal.status === 'complete'
                    ? 'bg-success/15 text-success'
                    : 'bg-warning/15 text-warning',
                )}
              >
                {goal.status === 'complete' ? t('chat:state.goalDone') : t('chat:state.goalActive')}
              </span>
              {goal.budget_tokens != null && (
                <span className="text-muted-foreground">
                  {t('chat:state.goalBudget', { tokens: formatK(goal.budget_tokens) })}
                </span>
              )}
            </div>
            <div className="text-foreground truncate" title={goal.text}>{goal.text}</div>
            {goal.completion_note && (
              <div className="text-muted-foreground italic truncate" title={goal.completion_note}>
                {goal.completion_note}
              </div>
            )}
          </div>
        </div>
      )}

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
  const out: Record<string, number> = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const t of tasks) {
    const k = t.status in out ? t.status : 'pending';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
