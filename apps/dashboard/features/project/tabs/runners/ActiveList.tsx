/**
 * Active (and recently-finished) runs for the current project. Selecting
 * a run shows its output on the right. Controls: Stop (running) and
 * Restart (any state). State is driven by the global store, so these
 * stay live even after navigating away and back.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square, RotateCcw, Loader2, X } from 'lucide-react';
import type { RunnerTask } from '@mcp/api-bus';
import { stopTask, restartTask, dismissTask } from '../../../../state/running-tasks.js';
import { cn } from '../../../../lib/utils.js';

interface ActiveListProps {
  tasks: RunnerTask[];
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}

function StatusBadge({ status }: { status: RunnerTask['status'] }) {
  const { t } = useTranslation(['projects']);
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
        <Loader2 className="h-3 w-3 animate-spin" /> {t('runners.status.running')}
      </span>
    );
  }
  if (status === 'exited') {
    return <span className="text-[10px] text-muted-foreground">{t('runners.status.exited')}</span>;
  }
  return <span className="text-[10px] text-amber-500">{t('runners.status.stopped')}</span>;
}

export function ActiveList({ tasks, selectedId, onSelect }: ActiveListProps) {
  const { t } = useTranslation(['projects']);
  const [error, setError] = useState<string | null>(null);
  async function control(action: () => Promise<unknown>) {
    setError(null);
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  if (tasks.length === 0) return null;

  return (
    <div className="border-b">
      {error && <div role="alert" className="px-3 py-2 text-xs text-red-400 break-words select-text">{error}</div>}
      <div className="px-3 py-1.5 bg-muted/30">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t('runners.active')}
        </span>
      </div>
      {tasks.map((task) => (
        <div
          key={task.taskId}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/60',
            task.taskId === selectedId && 'bg-accent',
          )}
          onClick={() => onSelect(task.taskId)}
        >
          <span className="flex-1 min-w-0">
            <span className="block text-xs font-medium truncate">{task.label}</span>
            <StatusBadge status={task.status} />
          </span>
          {task.status === 'running' && (
            <button
              type="button"
              className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-red-400 hover:bg-muted"
              aria-label={t('runners.stop')}
              title={t('runners.stop')}
              onClick={(e) => {
                e.stopPropagation();
                void control(() => stopTask(task.taskId));
              }}
            >
              <Square className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label={t('runners.restart')}
            title={t('runners.restart')}
            onClick={(e) => {
              e.stopPropagation();
              void control(async () => onSelect((await restartTask(task.taskId)).taskId));
            }}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          {task.status !== 'running' && (
            <button
              type="button"
              className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-red-400 hover:bg-muted"
              aria-label={t('runners.dismiss')}
              title={t('runners.dismiss')}
              onClick={(e) => {
                e.stopPropagation();
                void control(() => dismissTask(task.taskId));
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
