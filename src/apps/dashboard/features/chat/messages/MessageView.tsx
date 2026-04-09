import React from 'react';
import { Bot, GitBranch, Paperclip, User } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { Avatar, AvatarFallback } from '../../../components/ui/avatar.js';
import { cn } from '../../../lib/utils.js';
import { providerAccent } from '../constants.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type {
  ContentBlock,
  MessageRow,
  PersistedMessage,
  PersistedTasksState,
  PromptHandlers,
} from '../types.js';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { Markdown } from './Markdown.js';
import { ToolCallBlock } from './ToolCallBlock.js';

interface MessageViewProps {
  message: PersistedMessage;
  /** DB id of the persisted message row — used to fork from a user turn. */
  messageId?: number;
  toolResultsById: Map<string, { content: string; isError: boolean }>;
  usage?: MessageRow;
  providerId: string;
  onAnswer: PromptHandlers['onAnswer'];
  onPlanResponse: PromptHandlers['onPlanResponse'];
  onTasksResponse: PromptHandlers['onTasksResponse'];
  onFork?: PromptHandlers['onFork'];
  /** Persisted task list state from coder_tasks_state — used to overlay live
   *  task statuses on top of the frozen tool_use input snapshot. */
  tasksState?: PersistedTasksState | null;
}

export const MessageView = React.memo(MessageViewInner, (prev, next) => {
  // Persisted messages are immutable once committed; reference equality on
  // `message` and `usage` is enough. `toolResultsById` / `tasksState` change
  // refs when the session refetches, which is exactly when we WANT a rerender.
  return (
    prev.message === next.message &&
    prev.messageId === next.messageId &&
    prev.usage === next.usage &&
    prev.toolResultsById === next.toolResultsById &&
    prev.tasksState === next.tasksState &&
    prev.providerId === next.providerId &&
    prev.onAnswer === next.onAnswer &&
    prev.onPlanResponse === next.onPlanResponse &&
    prev.onTasksResponse === next.onTasksResponse &&
    prev.onFork === next.onFork
  );
});

function MessageViewInner({
  message,
  messageId,
  toolResultsById,
  usage,
  providerId,
  onAnswer,
  onPlanResponse,
  onTasksResponse,
  onFork,
  tasksState,
}: MessageViewProps) {
  const cacheRead = usage?.cache_read_tokens ?? 0;
  const tokenBadge =
    usage && (usage.input_tokens > 0 || usage.output_tokens > 0) ? (
      <span className="text-[10px] text-muted-foreground tabular-nums ml-1.5 inline-flex items-center gap-1">
        <span>
          ↑{usage.input_tokens.toLocaleString()} ↓{usage.output_tokens.toLocaleString()}
        </span>
        {cacheRead > 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">⚡{cacheRead.toLocaleString()}</span>
        )}
      </span>
    ) : null;

  if (message.role === 'user')
    return (
      <UserMessage
        message={message}
        tokenBadge={tokenBadge}
        onFork={onFork && messageId != null ? () => onFork(messageId) : undefined}
      />
    );
  if (message.role === 'tool') return null;

  // Concatenate every text block of the assistant turn into a single
  // markdown string for the per-message copy button.
  const assistantMarkdown = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n\n');

  return (
    <div className="flex gap-3 items-start group/msg">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className={cn('text-white', providerAccent(providerId))}>
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 max-w-[85%]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
          <span>assistant{tokenBadge}</span>
          {assistantMarkdown && <CopyMarkdownButton text={assistantMarkdown} />}
        </div>
        <div className="rounded-2xl rounded-tl-sm border bg-card px-4 py-3 shadow-sm max-h-[60vh] overflow-y-auto">
          {message.content.map((b, i) =>
            renderAssistantBlock(b, i, { onAnswer, onPlanResponse, onTasksResponse }, toolResultsById, tasksState),
          )}
        </div>
      </div>
    </div>
  );
}

function UserMessage({
  message,
  tokenBadge,
  onFork,
}: {
  message: PersistedMessage;
  tokenBadge: React.ReactNode;
  onFork?: () => void;
}) {
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  const images = message.content.filter((b) => b.type === 'image');
  const docs = message.content.filter((b) => b.type === 'document');
  return (
    <div className="flex gap-3 items-start justify-end group/user">
      <div className="flex-1 min-w-0 max-w-[85%] flex flex-col items-end">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
          {onFork && (
            <button
              type="button"
              onClick={onFork}
              title="Fork a new session from this message"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 group-hover/user:opacity-100 hover:bg-muted hover:text-foreground transition-opacity"
            >
              <GitBranch className="h-3 w-3" />
              Fork from here
            </button>
          )}
          <span>you{tokenBadge}</span>
        </div>
        <div className="rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2.5 shadow-sm max-h-[60vh] max-w-[100%] overflow-y-auto">
          {text && <div className="text-sm whitespace-pre-wrap break-words">{text}</div>}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {images.map((img, i) => (
                <a
                  key={i}
                  href={`data:${img.mediaType};base64,${img.base64}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt="attachment"
                    className="max-h-48 rounded-lg border border-primary-foreground/20"
                  />
                </a>
              ))}
            </div>
          )}
          {docs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {docs.map((d, i) => (
                <span
                  key={i}
                  className="text-[11px] px-2 py-0.5 rounded-md bg-primary-foreground/15 inline-flex items-center gap-1"
                >
                  <Paperclip className="h-3 w-3" /> {d.name ?? 'document'}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="bg-muted text-muted-foreground">
          <User className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
    </div>
  );
}

export function renderAssistantBlock(
  b: ContentBlock,
  i: number,
  handlers: PromptHandlers,
  toolResultsById: Map<string, { content: string; isError: boolean }>,
  tasksState: PersistedTasksState | null | undefined,
) {
  if (b.type === 'text') {
    return (
      <div key={i} className="text-sm text-foreground/90">
        <Markdown text={b.text ?? ''} />
      </div>
    );
  }
  if (b.type !== 'tool_use') return null;

  const result = toolResultsById.get(b.id ?? '');

  // Pending native interaction tools (no result yet) → render the
  // interactive prompt so refresh / tab-switch can resume the flow.
  if (!result && b.name === 'submit_plan') {
    const planText = String((b.input as { plan?: unknown })?.plan ?? '');
    return (
      <PlanPromptView
        key={`pl-${b.id}-${i}`}
        plan={{ id: b.id ?? `pl-${i}`, plan: planText }}
        onResponse={handlers.onPlanResponse}
      />
    );
  }

  if (b.name === 'submit_tasks') {
    // Always render the rich TaskListReview for submit_tasks tool calls
    // (pending OR resolved). When the run already completed and we have a
    // tool_result, the resolved state hides the action buttons but keeps the
    // readable list. This avoids dumping a giant raw JSON tool_use block on
    // the user when they reopen an old session.
    //
    // We prefer the live coder_tasks_state row (passed via the tasksState
    // prop) for runtime task statuses; fallback to the frozen tool_use.input
    // snapshot when the row isn't loaded yet.
    const inp = (b.input ?? {}) as { summary?: string; tasks?: Array<Record<string, unknown>> };
    const tasks = tasksState?.tasks
      ? tasksState.tasks
      : (inp.tasks ?? []).map((t, ti) => ({
          id: String(t.id ?? `task_${ti}`),
          title: String(t.title ?? ''),
          description: String(t.description ?? ''),
          files: Array.isArray(t.files) ? (t.files as string[]) : [],
          references: Array.isArray(t.references)
            ? (t.references as Array<{ type: string; value: string }>)
            : [],
          depends_on: Array.isArray(t.depends_on) ? (t.depends_on as string[]) : [],
          suggested_mode: (t.suggested_mode === 'subagent' ? 'subagent' : 'inline') as 'inline' | 'subagent',
          estimated_complexity: (['small', 'medium', 'large'].includes(String(t.estimated_complexity))
            ? t.estimated_complexity
            : 'medium') as 'small' | 'medium' | 'large',
          status: 'pending' as const,
        }));
    // Detect approval/rejection from the tool_result text. The submit_tasks
    // handler always returns one of the two formatTasks*Result shapes (or an
    // err()) so we can pattern-match.
    const resolvedStatus: 'approved' | 'rejected' | undefined = result
      ? result.content.startsWith('Task list approved')
        ? 'approved'
        : 'rejected'
      : undefined;
    return (
      <TaskListReview
        key={`tl-${b.id}-${i}`}
        prompt={{
          tool_use_id: b.id ?? `tl-${i}`,
          summary: tasksState?.summary || String(inp.summary ?? ''),
          tasks,
          version: 1,
          resolved: resolvedStatus,
        }}
        onResponse={handlers.onTasksResponse}
      />
    );
  }

  if (!result && b.name === 'ask_user') {
    const inp = (b.input ?? {}) as {
      question?: string;
      options?: Array<{ label: string; value: string }>;
      allow_freeform?: boolean;
    };
    return (
      <QuestionPromptView
        key={`qq-${b.id}-${i}`}
        question={{
          id: b.id ?? `q-${i}`,
          question: String(inp.question ?? ''),
          options: inp.options,
          allowFreeform: Boolean(inp.allow_freeform),
        }}
        onAnswer={handlers.onAnswer}
      />
    );
  }

  const tc: ToolCallEvent = {
    id: b.id ?? '',
    name: b.name ?? '',
    input: b.input,
    result: result ? { content: result.content, isError: result.isError } : undefined,
    status: result ? (result.isError ? 'error' : 'done') : 'running',
  };
  return <ToolCallBlock key={`tu-${b.id}-${i}`} call={tc} />;
}
