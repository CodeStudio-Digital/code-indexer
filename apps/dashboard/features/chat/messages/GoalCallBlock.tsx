import { useTranslation } from 'react-i18next';
import { Target, Check, X, Loader2 } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { cn } from '../../../lib/utils.js';

/**
 * Rich inline rendering for goal-tool calls (create_goal / update_goal /
 * get_goal). The generic ToolCallBlock collapses these into a one-liner
 * which is easy to miss; a goal change is a session-wide event the user
 * wants to actually SEE landing in the conversation.
 *
 * Goal mutations remain visible in the transcript, but follow the compact
 * activity/timeline language used by the surrounding tool rows. The pinned
 * SessionStateBanner owns the persistent card treatment; repeating that
 * treatment inline made goals look like a second, competing surface.
 */
interface GoalCallBlockProps {
  call: ToolCallEvent;
}

export function GoalCallBlock({ call }: GoalCallBlockProps) {
  const { t } = useTranslation('chat');
  const input = (call.input ?? {}) as { goal?: unknown; status?: unknown; note?: unknown; budget_tokens?: unknown };
  const isCreate = call.name === 'create_goal';
  const isUpdate = call.name === 'update_goal';
  const isGet = call.name === 'get_goal';
  const isSupersede = isUpdate && input.status === 'superseded';
  const goalText = typeof input.goal === 'string' ? input.goal : '';
  const note = typeof input.note === 'string' ? input.note : '';
  const budget = typeof input.budget_tokens === 'number' ? input.budget_tokens : null;

  const completedHeading = isCreate
    ? t('messages.goalCreated')
    : isUpdate
      ? isSupersede
        ? t('messages.goalSuperseded')
        : t('messages.goalUpdated')
      : t('messages.goalRead');
  const failedHeading = isCreate
    ? t('messages.goalCreateFailed')
    : isUpdate
      ? t('messages.goalUpdateFailed')
      : t('messages.goalReadFailed');
  const runningHeading = isCreate
    ? t('messages.goalCreating')
    : isUpdate
      ? isSupersede
        ? t('messages.goalSuperseding')
        : t('messages.goalUpdating')
      : t('messages.goalReading');
  const heading = call.status === 'error'
    ? failedHeading
    : call.status === 'running'
      ? runningHeading
      : completedHeading;

  const railColor = call.status === 'error'
    ? 'border-destructive/50'
    : call.status === 'running'
      ? 'border-warning/50'
      : isCreate
        ? 'border-warning/50'
        : isSupersede
          ? 'border-muted-foreground/30'
          : isUpdate
          ? 'border-success/40'
          : 'border-info/30';
  const iconColor = call.status === 'error'
    ? 'text-destructive'
    : call.status === 'running'
      ? 'text-warning'
      : isCreate
        ? 'text-warning'
        : isSupersede
          ? 'text-muted-foreground'
          : isUpdate
          ? 'text-success'
          : 'text-info';
  const StatusIcon = call.status === 'running' ? Loader2 : call.status === 'error' ? X : Check;
  const statusColor = call.status === 'error'
    ? 'text-destructive'
    : call.status === 'running'
      ? 'text-warning'
      : isSupersede
        ? 'text-muted-foreground'
        : 'text-success';

  return (
    <div className={cn('group/goal my-1.5 border-l pl-3 text-xs', railColor)}>
      <div className="flex min-h-6 items-center gap-1.5 text-muted-foreground">
        <Target className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
        <span className="truncate font-medium">
          {heading}
        </span>
        <StatusIcon className={cn('h-3.5 w-3.5', statusColor, call.status === 'running' && 'animate-spin')} />
        {call.durationMs !== undefined && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
            {call.durationMs}ms
          </span>
        )}
      </div>
      {goalText && (
        <div className="mt-0.5 text-[13px] font-normal leading-5 text-foreground/90" title={goalText}>
          {goalText}
        </div>
      )}
      {note && (
        <div className="mt-0.5 text-[11px] italic leading-4 text-muted-foreground" title={note}>
          {note}
        </div>
      )}
      {budget != null && (
        <div className="mt-0.5 text-[10px] text-muted-foreground/70">
          {t('messages.goalBudget', { tokens: formatK(budget) })}
        </div>
      )}
      {call.result && !goalText && !call.result.isError && (
        // get_goal returns the current state in result.content — show it
        // as plain text so the user can see what the model just read.
        <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-4 text-foreground/80">
          {call.result.content}
        </pre>
      )}
      {call.result?.isError && (
        <div role="alert" className="mt-0.5 text-[11px] leading-4 text-destructive">
          {call.result.content}
        </div>
      )}
    </div>
  );
}

const GOAL_TOOLS = new Set(['create_goal', 'update_goal', 'get_goal']);

export function isGoalTool(name: string): boolean {
  return GOAL_TOOLS.has(name);
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
