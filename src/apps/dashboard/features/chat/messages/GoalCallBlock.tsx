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
 * Matches the visual language of SessionStateBanner so eye-tracking is
 * consistent between the pinned header and the inline event.
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
  const goalText = typeof input.goal === 'string' ? input.goal : '';
  const note = typeof input.note === 'string' ? input.note : '';
  const budget = typeof input.budget_tokens === 'number' ? input.budget_tokens : null;

  const heading = isCreate
    ? t('messages.goalCreated')
    : isUpdate
      ? t('messages.goalUpdated')
      : t('messages.goalRead');

  const accent = isCreate ? 'border-warning/40 bg-warning/5' : isUpdate ? 'border-success/40 bg-success/5' : 'border-info/30 bg-info/5';
  const iconColor = isCreate ? 'text-warning' : isUpdate ? 'text-success' : 'text-info';
  const StatusIcon = call.status === 'running' ? Loader2 : call.status === 'error' ? X : Check;
  const statusColor = call.status === 'error' ? 'text-destructive' : call.status === 'running' ? 'text-warning' : 'text-success';

  return (
    <div className={cn('my-2 rounded-lg border p-3', accent)}>
      <div className="flex items-center gap-2 mb-1">
        <Target className={cn('h-4 w-4', iconColor)} />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-1">
          {heading}
        </span>
        <StatusIcon className={cn('h-3.5 w-3.5', statusColor, call.status === 'running' && 'animate-spin')} />
      </div>
      {goalText && (
        <div className="text-sm text-foreground" title={goalText}>{goalText}</div>
      )}
      {note && (
        <div className="text-xs text-muted-foreground italic mt-1" title={note}>{note}</div>
      )}
      {budget != null && (
        <div className="text-[10px] text-muted-foreground mt-1">
          {t('messages.goalBudget', { tokens: formatK(budget) })}
        </div>
      )}
      {call.result && !goalText && (
        // get_goal returns the current state in result.content — show it
        // as plain text so the user can see what the model just read.
        <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap mt-1">{call.result.content}</pre>
      )}
      {call.result?.isError && (
        <div className="text-xs text-destructive mt-1">{call.result.content}</div>
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
