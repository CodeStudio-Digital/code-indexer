/**
 * Plans & Tasks tab — read-only view of the session's submitted plan (latest)
 * and current task list. The plan is a compact clickable card; a click opens
 * it full in a modal rendered as markdown. Tasks stay inline (compact).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, ListChecks } from 'lucide-react';
import { Markdown } from '../messages/Markdown.js';
import { DriveDetailDialog } from './DriveDetailDialog.js';
import type { DrivePlan, DriveTasks } from './types.js';

const STATUS_TONE: Record<string, string> = {
  approved: 'text-emerald-500',
  pending: 'text-amber-500',
  rejected: 'text-destructive',
  aborted: 'text-muted-foreground',
  completed: 'text-emerald-500',
  in_progress: 'text-sky-500',
};

export function DrivePlansTab({ plans, tasks }: { plans: DrivePlan[]; tasks: DriveTasks | null }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const latest = plans[0] ?? null;
  const taskList = tasks?.tasks ?? [];

  if (!latest && taskList.length === 0) {
    return <div className="text-xs text-muted-foreground text-center py-8">{t('drive.plansEmpty', 'No plan or tasks yet.')}</div>;
  }

  return (
    <div className="space-y-4">
      {latest && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <ClipboardList className="h-3 w-3" />
            {t('drive.plan', 'Plan')}
            <span className={`ml-auto font-medium ${STATUS_TONE[latest.status] ?? ''}`}>{latest.status}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={t('drive.viewFull', 'Open full')}
            className="w-full text-left rounded border border-border/40 bg-muted/20 px-2 py-1.5 hover:bg-muted/40 transition-colors"
          >
            <p className="text-[11px] text-foreground/80 line-clamp-3 whitespace-pre-wrap break-words">
              {latest.plan_text.replace(/[#*`>_-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)}
            </p>
          </button>
        </div>
      )}

      {taskList.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <ListChecks className="h-3 w-3" />
            {t('drive.tasks', 'Tasks')}
            <span className="tabular-nums">({taskList.length})</span>
          </div>
          <ul className="space-y-0.5">
            {taskList.map((task) => (
              <li key={task.id} className="flex items-baseline gap-2 text-[11px]">
                <span className={`shrink-0 ${STATUS_TONE[task.status ?? ''] ?? 'text-muted-foreground'}`}>●</span>
                <span className="truncate flex-1" title={task.title}>{task.title}</span>
                {task.status && <span className="text-[10px] text-muted-foreground shrink-0">{task.status}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {latest ? (
        <DriveDetailDialog
          open={open}
          onOpenChange={setOpen}
          title={t('drive.plan', 'Plan')}
          meta={latest.status}
        >
          <Markdown text={latest.plan_text} />
        </DriveDetailDialog>
      ) : null}
    </div>
  );
}
