import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ClipboardList, X } from 'lucide-react';
import type { StreamTask, StreamTaskExecutionMode, TasksPrompt } from '../../../hooks/useAgentStream.js';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';
import { TaskRow } from './TaskRow.js';
import {
  getPromptDraft,
  markPromptResolved,
  setPromptDraft,
} from '../../../hooks/agent-stream/prompt-resolution-store.js';
import { usePromptResolution } from '../../../hooks/agent-stream/usePromptResolution.js';

interface TaskListReviewProps {
  prompt: TasksPrompt;
  onResponse: (verdict: {
    approved: boolean;
    feedback?: string;
    tasks?: StreamTask[];
    execution_mode?: StreamTaskExecutionMode;
  }) => Promise<void>;
  /** Bridges this card to its persisted twin, which carries a different id. */
  signature?: string;
  sessionId?: string;
}

interface TasksDraft {
  feedback: string;
  executionMode: StreamTaskExecutionMode;
  perTaskMode: Record<string, 'inline' | 'subagent'>;
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
export function TaskListReview({ prompt, onResponse, signature, sessionId }: TaskListReviewProps) {
  const { t } = useTranslation(['chat', 'common']);
  // Virtualization unmounts this card off-screen; the draft and the verdict both
  // live in a store so scrolling away does not reset the review.
  const draft = getPromptDraft<TasksDraft>(prompt.tool_use_id);
  const [feedback, setFeedback] = useState(draft?.feedback ?? '');
  const [executionMode, setExecutionMode] = useState<StreamTaskExecutionMode>(
    draft?.executionMode ?? 'inline',
  );
  const storedResolution = usePromptResolution<'approved' | 'rejected'>(
    prompt.tool_use_id, signature, sessionId,
  );
  const resolved = prompt.resolved ?? storedResolution;
  const [open, setOpen] = useState(() => !prompt.resolved);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * Per-task mode overrides — only meaningful when global executionMode is
   * 'per-task'. Keyed by task id; falls back to suggested_mode when missing.
   */
  const [perTaskMode, setPerTaskMode] = useState<Record<string, 'inline' | 'subagent'>>(
    draft?.perTaskMode ?? {},
  );

  useEffect(() => {
    setPromptDraft(prompt.tool_use_id, { feedback, executionMode, perTaskMode });
  }, [executionMode, feedback, perTaskMode, prompt.tool_use_id]);

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
    markPromptResolved({
      id: prompt.tool_use_id, signature, sessionId, resolution: 'approved',
    });
    setOpen(false);
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/70 bg-card/45">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
        <ClipboardList className="h-4 w-4 shrink-0 text-info" />
        <div className="flex-1 text-xs font-medium text-foreground/85">
          {t('chat:tasks.header', { count: tasksForRender.length })}
          {resolved && ` · ${t(resolved === 'approved' ? 'chat:plan.approved' : 'chat:plan.rejected')}`}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/60 px-3 py-3">
          {prompt.summary && (
            <div className="mb-3 px-1 text-sm text-foreground/90">
              <Markdown text={prompt.summary} />
            </div>
          )}

          <div className="mb-3 space-y-2">
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
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Execution mode:</span>
                {EXECUTION_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setExecutionMode(mode)}
                    className={cn(
                      'rounded border px-2 py-1 text-[11px] transition-colors',
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
                    markPromptResolved({
                      id: prompt.tool_use_id, signature, sessionId, resolution: 'rejected',
                    });
                    setOpen(false);
                  }}
                >
                  <X className="h-3.5 w-3.5" /> {t('common:actions.reject')}
                </Button>
              </div>
            </>
          ) : (
            <div
              className={cn(
                'flex items-center gap-1.5 text-xs',
                resolved === 'approved' ? 'text-success' : 'text-destructive',
              )}
            >
              {resolved === 'approved' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
              {t(resolved === 'approved' ? 'chat:plan.approved' : 'chat:plan.rejected')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
