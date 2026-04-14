import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, X } from 'lucide-react';
import type { StreamTask, StreamTaskExecutionMode, TasksPrompt } from '../../../hooks/useAgentStream.js';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';
import { TaskRow } from './TaskRow.js';

interface TaskListReviewProps {
  prompt: TasksPrompt;
  onResponse: (verdict: {
    approved: boolean;
    feedback?: string;
    tasks?: StreamTask[];
    execution_mode?: StreamTaskExecutionMode;
  }) => Promise<void>;
}

const EXECUTION_MODES: readonly StreamTaskExecutionMode[] = [
  'inline',
  'all-subagent',
  'smart',
  'per-task',
] as const;

/**
 * Renders a structured task list submitted via submit_tasks. Lets the user
 * pick a global execution mode (inline / all-subagent / smart / per-task),
 * optionally override per-task mode, and approve or reject the whole list.
 *
 * Phase 1 keeps editing minimal — descriptions are read-only — so the user
 * can mainly approve/reject and pick the execution mode. Editing comes in
 * Phase 3.
 */
export function TaskListReview({ prompt, onResponse }: TaskListReviewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [feedback, setFeedback] = useState('');
  const [executionMode, setExecutionMode] = useState<StreamTaskExecutionMode>('inline');
  const [resolved, setResolved] = useState<'approved' | 'rejected' | undefined>(prompt.resolved);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * Per-task mode overrides — only meaningful when global executionMode is
   * 'per-task'. Keyed by task id; falls back to suggested_mode when missing.
   */
  const [perTaskMode, setPerTaskMode] = useState<Record<string, 'inline' | 'subagent'>>({});

  const toggleExpand = (id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tasksForRender = prompt.tasks; // live updates flow via the parent state

  const handleApprove = async () => {
    // For per-task mode, mutate each task's suggested_mode with the user
    // override so the server-side resolver picks the right mode for
    // execute_task. Other modes leave the tasks untouched.
    const tasksOut =
      executionMode === 'per-task'
        ? tasksForRender.map((t) => ({
            ...t,
            suggested_mode: perTaskMode[t.id] ?? t.suggested_mode,
          }))
        : undefined;
    await onResponse({ approved: true, feedback, execution_mode: executionMode, tasks: tasksOut });
    setResolved('approved');
  };

  return (
    <div className="my-3 rounded-xl border border-info/40 bg-info/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-info/15 text-info flex items-center justify-center">
          <ClipboardList className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-info uppercase tracking-wider flex-1">
          {t('chat:tasks.header', { count: tasksForRender.length })}
          {resolved && ` · ${resolved}`}
        </div>
      </div>

      {prompt.summary && (
        <div className="text-sm text-foreground/90 mb-3 px-1">
          <Markdown text={prompt.summary} />
        </div>
      )}

      <div className="space-y-2 mb-3">
        {tasksForRender.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            isExpanded={expanded.has(task.id)}
            onToggle={() => toggleExpand(task.id)}
            executionMode={executionMode}
            resolved={resolved}
            perTaskMode={perTaskMode[task.id]}
            onPerTaskModeChange={(mode) => setPerTaskMode((m) => ({ ...m, [task.id]: mode }))}
          />
        ))}
      </div>

      {!resolved ? (
        <>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Execution mode:</span>
            {EXECUTION_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setExecutionMode(mode)}
                className={cn(
                  'text-[11px] px-2 py-1 rounded border transition-colors',
                  executionMode === mode
                    ? 'border-info bg-info/10 text-info'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t('chat:plan.feedbackPlaceholder')}
            rows={2}
            className="mb-2 text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" variant="success" onClick={handleApprove}>
              <Check className="h-3.5 w-3.5" /> {t('common:actions.approve')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                await onResponse({ approved: false, feedback });
                setResolved('rejected');
              }}
            >
              <X className="h-3.5 w-3.5" /> {t('common:actions.reject')}
            </Button>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'text-xs flex items-center gap-1.5',
            resolved === 'approved' ? 'text-success' : 'text-destructive',
          )}
        >
          {resolved === 'approved' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          {resolved}
        </div>
      )}
    </div>
  );
}
