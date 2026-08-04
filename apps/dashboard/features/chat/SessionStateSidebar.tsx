import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Circle, ListChecks, Loader2, Target } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import type {
  ActiveProcess,
  TodoItem,
} from '../../hooks/agent-stream/types.js';
import { ActiveProcessesSection } from './sidebar/ActiveProcessesSection.js';
import { CollapsibleSection } from './sidebar/CollapsibleSection.js';
import { ProjectFilesSection } from './sidebar/ProjectFilesSection.js';
import { SkillsSection } from './sidebar/SkillsSection.js';

interface GoalSummary {
  text: string;
  status: 'in_progress' | 'complete' | 'superseded';
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
  /** Persisted todos rehydrated from the bundle state projection, used as a fallback
   *  on session mount before any todos_updated SSE event arrives. */
  todos?: TodoItem[];
}

interface SessionStateSidebarProps {
  sessionId: string;
  refreshKey?: number;
  onActiveTaskChange?: (taskId: string | null) => void;
  todos: TodoItem[];
  projectId: number | null;
  filePicks: string[];
  onTogglePick: (path: string) => void;
  onSetManyPicks: (paths: string[], select: boolean) => void;
  onClearPicks: () => void;
  /** Skill IDs the user has pre-selected for injection on the next send. */
  skillPicks: string[];
  onToggleSkillPick: (id: string) => void;
  /** Transient processes from the live session stream. */
  activeProcesses?: ActiveProcess[];
  /**
   * When true, the sidebar drops its own `<aside>` wrapper (with border-l
   * + w-64 + hidden lg:block) and renders as a plain scrollable block so
   * it fits inside a parent that owns the chrome — e.g. `PanelChrome`
   * inside the right-rail `RightPanelHost`.
   */
  embedded?: boolean;
}

/**
 * Right-side panel with collapsible sections: Goal, Tasks, Todos, and a
 * project-files browser with selection that feeds the composer.
 */
export function SessionStateSidebar({
  sessionId,
  refreshKey,
  onActiveTaskChange,
  todos,
  projectId,
  filePicks,
  onTogglePick,
  onSetManyPicks,
  skillPicks,
  onToggleSkillPick,
  activeProcesses = [],
  embedded,
}: SessionStateSidebarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [data, setData] = useState<StateSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/coder/sessions/${sessionId}/state-summary`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: StateSummary) => {
        if (!cancelled) {
          setData(d);
          if (onActiveTaskChange) onActiveTaskChange(d.tasks?.current_task_id ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey, onActiveTaskChange]);

  const goal = data?.goal ?? null;
  const tasks = data?.tasks ?? null;

  // Prefer the live SSE-driven prop. Fall back to the snapshot returned by
  // /state-summary on mount so a session reload (or resume after server
  // restart) shows the persisted todos immediately, without waiting for the
  // next todos_updated event from the runner.
  const effectiveTodos: TodoItem[] = todos.length > 0 ? todos : (data?.todos ?? []);

  const taskCounts = tasks ? countByStatus(tasks.tasks) : null;
  const todosCompleted = effectiveTodos.filter((td) => td.status === 'completed').length;
  const todosTotal = effectiveTodos.length;
  const todosPercent = todosTotal === 0 ? 0 : Math.round((todosCompleted / todosTotal) * 100);

  // NOTE: choose a *stable host element* by the `embedded` flag instead of
  // defining a `Wrapper` component inside render. An inline component is a
  // new type every render, which makes React unmount+remount the whole
  // subtree each render — that remount storm tripped React's
  // "Maximum update depth exceeded" guard.
  const sections = (
    <>
      <ActiveProcessesSection sessionId={sessionId} processes={activeProcesses} />
      {goal && (
        <CollapsibleSection
          id="goal"
          sessionId={sessionId}
          title={t('chat:state.goalLabel')}
          icon={
            <Target
              className={cn(
                'h-3.5 w-3.5',
                goal.status === 'complete'
                  ? 'text-success'
                  : goal.status === 'superseded'
                    ? 'text-muted-foreground'
                    : 'text-warning',
              )}
            />
          }
          headerExtra={
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-medium',
                goal.status === 'complete'
                  ? 'bg-success/15 text-success'
                  : goal.status === 'superseded'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-warning/15 text-warning',
              )}
            >
              {goal.status === 'complete'
                ? t('chat:state.goalDone')
                : goal.status === 'superseded'
                  ? t('chat:state.goalSuperseded')
                  : t('chat:state.goalActive')}
            </span>
          }
          defaultOpen
        >
          <div className="px-3 py-2 text-xs space-y-1">
            <div className="text-foreground" title={goal.text}>
              {goal.text}
            </div>
            {goal.budget_tokens != null && (
              <div className="text-muted-foreground">
                {t('chat:state.goalBudget', { tokens: formatK(goal.budget_tokens) })}
              </div>
            )}
            {goal.completion_note && (
              <div className="text-muted-foreground italic" title={goal.completion_note}>
                {goal.completion_note}
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {tasks && (
        <CollapsibleSection
          id="tasks"
          sessionId={sessionId}
          title={t('chat:state.tasksLabel')}
          icon={<ListChecks className="h-3.5 w-3.5 text-info" />}
          headerExtra={
            !tasks.approved ? (
              <span className="px-1.5 py-0.5 rounded bg-warning/15 text-warning text-[10px] font-medium">
                {t('chat:state.tasksAwaiting')}
              </span>
            ) : null
          }
          subtitle={
            <>
              {taskCounts && (
                <div>{t('chat:state.tasksCounts', taskCounts)}</div>
              )}
              {tasks.execution_mode && (
                <div>{t('chat:state.tasksMode', { mode: tasks.execution_mode })}</div>
              )}
            </>
          }
          defaultOpen
        >
          {tasks.summary && (
            <div className="px-3 py-1 text-xs text-muted-foreground" title={tasks.summary}>
              {tasks.summary}
            </div>
          )}
          <ul className="px-2 pb-2 space-y-1">
            {tasks.tasks.map((task) => {
              const isCurrent = task.id === tasks.current_task_id;
              return (
                <li
                  key={task.id}
                  className={cn(
                    'flex items-start gap-2 text-xs px-1.5 py-1.5 rounded transition-colors',
                    isCurrent ? 'bg-info/10' : 'hover:bg-muted/50',
                  )}
                >
                  <span className="mt-0.5 shrink-0">{taskStatusIcon(task.status, isCurrent)}</span>
                  <span
                    className={cn(
                      (task.status === 'done' || task.status === 'skipped') && 'text-muted-foreground line-through',
                      task.status === 'failed' && 'text-destructive',
                      task.status === 'interrupted' && 'text-warning',
                      isCurrent && 'text-foreground font-medium',
                      !isCurrent &&
                        task.status !== 'done' &&
                        task.status !== 'skipped' &&
                        task.status !== 'failed' &&
                        task.status !== 'interrupted' &&
                        'text-muted-foreground',
                    )}
                    title={task.title}
                  >
                    {task.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </CollapsibleSection>
      )}

      {effectiveTodos.length > 0 && (
        <CollapsibleSection
          id="todos"
          sessionId={sessionId}
          title={t('chat:todos.title')}
          headerExtra={
            <span className="text-[10px] text-muted-foreground">
              {t('chat:todos.progress', {
                completed: todosCompleted,
                total: todosTotal,
                percent: todosPercent,
              })}
            </span>
          }
          subtitle={
            <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${todosPercent}%` }}
              />
            </div>
          }
          defaultOpen
        >
          <ul className="px-2 py-2 space-y-1">
            {effectiveTodos.map((td, i) => (
              <li
                key={td.id ?? `legacy-${i}-${td.content}`}
                className="flex items-start gap-2 text-xs px-1.5 py-1.5 rounded hover:bg-muted/50 transition-colors"
              >
                <span className="mt-0.5 shrink-0">
                  {td.status === 'completed' ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : td.status === 'in_progress' ? (
                    <Loader2 className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </span>
                <span
                  className={
                    td.status === 'completed'
                      ? 'text-muted-foreground line-through'
                      : td.status === 'in_progress'
                        ? 'text-foreground font-medium'
                        : 'text-muted-foreground'
                  }
                >
                  {td.status === 'in_progress' ? td.activeForm : td.content}
                </span>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      )}

      {projectId != null && (
        <ProjectFilesSection
          sessionId={sessionId}
          projectId={projectId}
          selected={filePicks}
          onToggleSelect={onTogglePick}
          onSetMany={onSetManyPicks}
        />
      )}

      <SkillsSection
        sessionId={sessionId}
        selected={skillPicks}
        onToggleSelect={onToggleSkillPick}
      />
    </>
  );

  return embedded ? (
    <div className="h-full w-full overflow-y-auto">{sections}</div>
  ) : (
    <aside className="border-l bg-card/50 w-64 shrink-0 overflow-y-auto hidden lg:block">
      {sections}
    </aside>
  );
}

function taskStatusIcon(status: string, isCurrent: boolean) {
  if (status === 'done') {
    return <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
  }
  if (status === 'running' || isCurrent) {
    return <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />;
  }
  if (status === 'failed') {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
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

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
