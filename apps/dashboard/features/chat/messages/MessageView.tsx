import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Brain, ChevronDown, ChevronRight, FileText, GitBranch, ImageIcon, Loader2, Paperclip, RotateCcw, Sparkles, User } from 'lucide-react';
import type { DecisionAnswers, DecisionQuestion, StreamTask, ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { Avatar, AvatarFallback } from '../../../components/ui/avatar.js';
import { cn } from '../../../lib/utils.js';
import { providerAccent } from '../constants.js';
import { PlanPromptView } from '../prompts/PlanPromptView.js';
import { QuestionPromptView } from '../prompts/QuestionPromptView.js';
import { DecisionGateView } from '../prompts/DecisionGateView.js';
import { SpecPromptView } from '../prompts/SpecPromptView.js';
import { TaskListReview } from '../prompts/TaskListReview.js';
import type {
  ContentBlock,
  MessageRow,
  PersistedMessage,
  PersistedTasksState,
  PromptHandlers,
  ToolResultView,
} from '../types.js';
import { AgentsGroupBlock } from './AgentsGroupBlock.js';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { Markdown } from './Markdown.js';
import { TaskExecutionBlock, parseExecuteTasksResult } from './TaskExecutionBlock.js';
import { WorkflowBlock, parseWorkflowResult } from './WorkflowBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { TodoWriteBlock } from './TodoWriteBlock.js';
import { SelfReviewBlock } from './SelfReviewBlock.js';
import { GoalCallBlock, isGoalTool } from './GoalCallBlock.js';
import { FileEditBlock } from './FileEditBlock.js';
import { isEditTool } from './edit-tools.js';
import { deriveTaskCardState } from './task-card-state.js';
import { derivePlanResolution } from './plan-card-state.js';
import { parsePersistedAgentsGroup } from './agents-group-parser.js';
import { cleanThinkingMarkdown, thinkingPreviewText } from './thinking-text.js';

/**
 * `task_list` is the unified tool (merge of todo_write + submit_tasks). An
 * APPROVE-gate call carries structured items (title/description/files) and
 * renders as the TaskListReview approval card; a TRACK-gate call is a checklist
 * and renders as TodoWriteBlock. The legacy names (submit_tasks/todo_write/
 * update_todo) are matched by their own names.
 */
export function taskListIsApprove(input: unknown): boolean {
  const o = (input ?? {}) as Record<string, unknown>;
  if (o.gate === 'approve') return true;
  if (o.gate === 'track' || Array.isArray(o.updates) || Array.isArray(o.todos)) return false;
  const items = Array.isArray(o.items) ? o.items : Array.isArray(o.tasks) ? o.tasks : [];
  // Keep this field set identical to inferGate's APPROVE_FIELDS (tasks.ts) so
  // the render decision can never disagree with the backend handler dispatch.
  const APPROVE_FIELDS = [
    'title', 'description', 'files', 'kind', 'depends_on',
    'references', 'suggested_mode', 'estimated_complexity', 'parallel_group',
  ];
  return items.some((it) => {
    if (!it || typeof it !== 'object') return false;
    const r = it as Record<string, unknown>;
    return APPROVE_FIELDS.some((f) => {
      const v = r[f];
      return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '';
    });
  });
}

interface MessageViewProps {
  message: PersistedMessage;
  /** DB id of the persisted message row — used to fork from a user turn. */
  messageId?: number;
  /** Session id — needed to lazy-fetch attachment base64 stripped from the
   *  list payload (see sessions.ts trimMessageBlocks). */
  sessionId?: string;
  toolResultsById: Map<string, ToolResultView>;
  usage?: MessageRow;
  providerId: string;
  onAnswer: PromptHandlers['onAnswer'];
  onPlanResponse: PromptHandlers['onPlanResponse'];
  onTasksResponse: PromptHandlers['onTasksResponse'];
  onDecide?: PromptHandlers['onDecide'];
  onFork?: PromptHandlers['onFork'];
  onRollback?: PromptHandlers['onRollback'];
  rollbackPendingSeq?: number | null;
  /** Persisted task list state from the session task projection — used to overlay live
   *  task statuses on top of the frozen tool_use input snapshot. */
  tasksState?: PersistedTasksState | null;
  /** tool_use id of the session's CURRENT task list. Only the card with this
   *  id overlays `tasksState`; superseded cards render their frozen snapshot. */
  activeTasksToolUseId?: string | null;
}

export const MessageView = React.memo(MessageViewInner, (prev, next) => {
  // Persisted messages are immutable once committed; reference equality on
  // `message` and `usage` is enough. `toolResultsById` / `tasksState` change
  // refs when the session refetches, which is exactly when we WANT a rerender.
  return (
    prev.message === next.message &&
    prev.messageId === next.messageId &&
    prev.sessionId === next.sessionId &&
    prev.usage === next.usage &&
    prev.toolResultsById === next.toolResultsById &&
    prev.tasksState === next.tasksState &&
    prev.activeTasksToolUseId === next.activeTasksToolUseId &&
    prev.providerId === next.providerId &&
    prev.onAnswer === next.onAnswer &&
    prev.onPlanResponse === next.onPlanResponse &&
    prev.onTasksResponse === next.onTasksResponse &&
    prev.onFork === next.onFork &&
    prev.onRollback === next.onRollback &&
    prev.rollbackPendingSeq === next.rollbackPendingSeq
  );
});

function MessageViewInner({
  message,
  messageId,
  sessionId,
  toolResultsById,
  usage,
  providerId,
  onAnswer,
  onPlanResponse,
  onTasksResponse,
  onDecide,
  onFork,
  onRollback,
  rollbackPendingSeq,
  tasksState,
  activeTasksToolUseId,
}: MessageViewProps) {
  const { t } = useTranslation('chat');
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
        sessionId={sessionId}
        messageId={messageId}
        tokenBadge={tokenBadge}
        onFork={onFork && messageId != null ? () => onFork(messageId) : undefined}
        onRollback={onRollback && messageId != null ? () => onRollback(messageId) : undefined}
        rollbackPending={rollbackPendingSeq === messageId}
        rollbackDisabled={rollbackPendingSeq != null}
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
    <div className="group/msg w-full">
      <article className="w-full min-w-0 px-3 py-2 transition-colors hover:bg-muted/[0.018]">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-4 w-4 shrink-0 opacity-90">
              <AvatarFallback className={cn('text-white', providerAccent(providerId))}>
                <Bot className="h-2.5 w-2.5" />
              </AvatarFallback>
            </Avatar>
            <span className="font-semibold text-foreground/60">{t('messages.assistant')}</span>
            {tokenBadge}
          </div>
          {assistantMarkdown && <CopyMarkdownButton text={assistantMarkdown} />}
        </div>
        <div>
          {message.content.map((b, i) =>
            renderAssistantBlock(
              b,
              i,
              { onAnswer, onPlanResponse, onTasksResponse, onDecide },
              toolResultsById,
              tasksState,
              activeTasksToolUseId,
              sessionId,
            ),
          )}
        </div>
      </article>
    </div>
  );
}

function UserMessage({
  message,
  sessionId,
  messageId,
  tokenBadge,
  onFork,
  onRollback,
  rollbackPending,
  rollbackDisabled,
}: {
  message: PersistedMessage;
  sessionId?: string;
  messageId?: number;
  tokenBadge: React.ReactNode;
  onFork?: () => void;
  onRollback?: () => void;
  rollbackPending?: boolean;
  rollbackDisabled?: boolean;
}) {
  const { t } = useTranslation('chat');
  // Suppress the synthetic tool-image plumbing caption ("(Image(s) attached
  // from the tool call above.)") so a tool screenshot renders as a clean image
  // bubble. The string is the sentinel emitted by executing.ts.
  const TOOL_IMG_SENTINEL = '(Image(s) attached from the tool call above.)';
  const text = message.content
    .filter((b) => b.type === 'text' && (b.text ?? '').trim() !== TOOL_IMG_SENTINEL)
    .map((b) => b.text ?? '')
    .join('\n');
  const images = message.content.filter((b) => b.type === 'image');
  const docs = message.content.filter((b) => b.type === 'document');
  const hasStripped = useMemo(
    () => [...images, ...docs].some((b) => b._hasBase64 && !b.base64),
    [images, docs],
  );
  const [resolved, setResolved] = useState<ContentBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const ensureFull = async () => {
    if (resolved || loading) return;
    if (!sessionId || messageId == null || !hasStripped) return;
    setLoading(true);
    setFetchError(null);
    try {
      const r = await fetch(`/api/coder/sessions/${sessionId}/messages/${messageId}/full`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { content: ContentBlock[] };
      setResolved(data.content);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Resolve a stripped attachment block against the lazy-fetched full payload.
  // Match by id when present, then by name; fall back to positional index
  // among same-type blocks (user image blocks have no id).
  const resolveBlock = (b: ContentBlock, idx: number): ContentBlock => {
    if (b.base64 || !resolved) return b;
    const sameType = resolved.filter((r) => r.type === b.type);
    const byId = b.id ? sameType.find((r) => r.id === b.id && r.base64) : undefined;
    if (byId) return byId;
    const byName = b.name ? sameType.find((r) => r.name === b.name && r.base64) : undefined;
    if (byName) return byName;
    const positional = sameType[idx];
    return positional?.base64 ? positional : b;
  };

  const appliedSkills = message.selectedSkillIds ?? [];
  const hasUserBody = !!text || docs.length > 0 || !!fetchError;

  return (
    <div className="group/user group/msg w-full">
      <article className="w-full min-w-0 px-3 py-2">
        <div className="mb-1 flex items-center justify-end gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/75">
          <div className={cn(
            'flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/user:opacity-100 focus-within:opacity-100',
            rollbackPending && 'opacity-100',
          )}>
            {onFork && (
              <button
                type="button"
                onClick={onFork}
                title={t('messages.forkTitle')}
                className="group/action inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-all duration-200"
              >
                <GitBranch className="h-3 w-3" />
                <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/action:max-w-24 group-hover/action:opacity-100 group-focus/action:max-w-24 group-focus/action:opacity-100">{t('messages.fork')}</span>
              </button>
            )}
            {onRollback && (
              <button
                type="button"
                onClick={onRollback}
                disabled={rollbackDisabled}
                aria-busy={rollbackPending}
                title={t('messages.rollbackTitle')}
                className="group/action inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-all duration-200 disabled:pointer-events-none disabled:opacity-60"
              >
                {rollbackPending
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RotateCcw className="h-3 w-3" />}
                <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/action:max-w-24 group-hover/action:opacity-100 group-focus/action:max-w-24 group-focus/action:opacity-100">{t('messages.rollback')}</span>
              </button>
            )}
            {text && <CopyMarkdownButton text={text} />}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-primary/80">{t('messages.you')}</span>
            {tokenBadge}
            <Avatar className="h-4 w-4 shrink-0 opacity-90">
              <AvatarFallback className="bg-primary/10 text-primary">
                <User className="h-2.5 w-2.5" />
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
        {hasUserBody && (
          <div className="rounded-xl bg-primary/[0.055] px-3 py-2 text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.025)]">
            {text && (
              <div className="text-[13px] leading-5">
                <Markdown text={text} />
              </div>
            )}
            {docs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {docs.map((d, i) => (
                  <AttachmentDoc
                    key={`doc-${i}`}
                    block={resolveBlock(d, i)}
                    loading={loading}
                    onNeedsFetch={ensureFull}
                  />
                ))}
              </div>
            )}
            {fetchError && (
              <div className="text-[11px] text-destructive mt-1">attachment fetch failed: {fetchError}</div>
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <AttachmentImage
                key={`img-${i}`}
                block={resolveBlock(img, i)}
                loading={loading}
                onNeedsFetch={ensureFull}
              />
            ))}
          </div>
        )}
        {appliedSkills.length > 0 && (
          <div
            className="mt-1 flex flex-wrap justify-end gap-1"
            aria-label="Skills applied to this turn"
          >
            {appliedSkills.map((id) => (
              <span
                key={id}
                title={id}
                className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-violet-600 dark:text-violet-300"
              >
                <Sparkles className="h-2.5 w-2.5" />
                <span className="max-w-[140px] truncate">{id}</span>
              </span>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

/**
 * User-uploaded image: shows a thumbnail. If the base64 was stripped from
 * the list payload (server trims user attachments — see
 * sessions.ts trimMessageBlocks), the thumbnail is a placeholder card and
 * clicking it lazy-fetches the full message and opens a fullscreen modal.
 */
function AttachmentImage({
  block,
  loading,
  onNeedsFetch,
}: {
  block: ContentBlock;
  loading: boolean;
  onNeedsFetch: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const hasData = !!block.base64;
  const src = hasData ? `data:${block.mediaType};base64,${block.base64}` : null;

  // Open the modal automatically once a click-triggered fetch resolves.
  useEffect(() => {
    if (pendingOpen && hasData) {
      setOpen(true);
      setPendingOpen(false);
    }
  }, [pendingOpen, hasData]);

  const handleClick = () => {
    if (hasData) {
      setOpen(true);
      return;
    }
    setPendingOpen(true);
    void onNeedsFetch();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="relative h-20 w-20 overflow-hidden rounded-md border border-border/45 bg-card/75 cursor-zoom-in transition-all duration-150 hover:border-primary/45 hover:opacity-95 hover:shadow-sm"
        title={hasData ? 'Open preview' : 'Load preview'}
      >
        {src ? (
          <img src={src} alt="attachment" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            {loading || pendingOpen ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <ImageIcon className="h-5 w-5" />
            )}
            <span className="text-[10px]">
              {loading || pendingOpen ? 'Loading…' : 'Preview'}
            </span>
          </div>
        )}
      </button>
      {open && src && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-zoom-out"
          onClick={() => setOpen(false)}
          role="button"
          tabIndex={-1}
        >
          <img
            src={src}
            alt="attachment full size"
            className="max-w-full max-h-full rounded shadow-xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

/**
 * User-uploaded document chip. Click lazy-fetches the full base64 (when
 * stripped) and opens it in a new tab as a data URL.
 */
function AttachmentDoc({
  block,
  loading,
  onNeedsFetch,
}: {
  block: ContentBlock;
  loading: boolean;
  onNeedsFetch: () => void | Promise<void>;
}) {
  const [pendingOpen, setPendingOpen] = useState(false);
  const hasData = !!block.base64;
  const hasPath = !!block.path;
  const src = hasData ? `data:${block.mediaType};base64,${block.base64}` : null;

  useEffect(() => {
    if (pendingOpen && src) {
      window.open(src, '_blank', 'noopener,noreferrer');
      setPendingOpen(false);
    }
  }, [pendingOpen, src]);

  const handleClick = () => {
    if (hasPath && block.path) {
      window.electronAPI?.openPath?.(block.path);
      return;
    }
    if (src) {
      window.open(src, '_blank', 'noopener,noreferrer');
      return;
    }
    setPendingOpen(true);
    void onNeedsFetch();
  };

  const busy = loading || pendingOpen;

  return (
    <button
      type="button"
      onClick={handleClick}
      className="text-[11px] px-2 py-0.5 rounded-md bg-primary-foreground/15 inline-flex items-center gap-1 hover:bg-primary-foreground/25 transition-colors"
      title={hasPath ? block.path : hasData ? 'Open document' : 'Load document'}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : block.mediaType?.startsWith('application/pdf') ? (
        <FileText className="h-3 w-3" />
      ) : (
        <Paperclip className="h-3 w-3" />
      )}
      {block.name ?? 'document'}
    </button>
  );
}

// Resolved (historical) interactive cards render no action buttons, so these
// handlers are never actually invoked — they just satisfy the required props.
const noopPlanResponse = async (): Promise<void> => {};
const noopAnswer = async (): Promise<void> => {};
const noopSpecResponse = async (): Promise<void> => {};
const noopDecide = async (): Promise<void> => {};

/**
 * Best-effort reconstruction of the chosen option values from a resolved
 * decision_gate's tool_result text (`formatDecisionGateResult` output) so the
 * history card can highlight what was picked. Matches each question's decided
 * line by header/id, then maps the printed labels back to option values. Falls
 * back to no highlight when a label can't be matched — the line text still
 * conveys the decision.
 */
function reconstructDecisionAnswers(resultText: string, questions: DecisionQuestion[]): DecisionAnswers {
  const answers: DecisionAnswers = {};
  // formatDecisionGateResult emits exactly one "- ..." line per question, in
  // question order. Match positionally — NOT by header text — so two questions
  // sharing a header don't both resolve to the first line.
  const itemLines = resultText.split('\n').filter((l) => l.startsWith('- '));
  questions.forEach((q, i) => {
    const line = itemLines[i];
    if (!line) { answers[q.id] = { selected: [] }; return; }
    // Strip the "- <label>:" prefix (label is q.header || q.id); fall back to a
    // generic prefix strip if the label doesn't line up.
    const prefix = `- ${(q.header?.trim() || q.id)}:`;
    const rest = line.startsWith(prefix) ? line.slice(prefix.length) : line.replace(/^- [^:]*:/, '');
    const [choicePart, notePart] = rest.split(' — note: ');
    const chosenLabels = choicePart.split(',').map((s) => s.trim());
    const selected = q.options.filter((o) => chosenLabels.includes(o.label)).map((o) => o.value);
    answers[q.id] = { selected, ...(notePart ? { freeform: notePart.trim() } : {}) };
  });
  return answers;
}

export function renderAssistantBlock(
  b: ContentBlock,
  i: number,
  handlers: PromptHandlers,
  toolResultsById: Map<string, ToolResultView>,
  tasksState: PersistedTasksState | null | undefined,
  activeTasksToolUseId?: string | null,
  sessionId?: string,
) {
  const maybeThinking = b as unknown as { type?: string; text?: string };
  if (maybeThinking.type === 'thinking') {
    return <ThinkingBlockView key={`think-${i}`} text={maybeThinking.text ?? ''} />;
  }
  if (b.type === 'text') {
    return (
      <div key={i} className="text-[13px] leading-5 text-foreground/90">
        <Markdown text={b.text ?? ''} />
      </div>
    );
  }
  if (b.type === 'image') {
    return (
      <GeneratedImageBlock
        key={`img-${i}`}
        mediaType={b.mediaType ?? 'image/png'}
        base64={b.base64 ?? ''}
      />
    );
  }
  if (b.type !== 'tool_use') return null;

  const result = toolResultsById.get(b.id ?? '');

  // Native interaction tools. While PENDING (no result) → interactive prompt so
  // refresh / tab-switch can resume the flow. Once ANSWERED → collapsed-by-default
  // ToolCallBlock whose expanded body is the resolved card (no raw JSON dump).
  if (b.name === 'submit_plan') {
    const planText = String((b.input as { plan?: unknown })?.plan ?? '');
    if (!result) {
      return (
        <PlanPromptView
          key={`pl-${b.id}-${i}`}
          plan={{ id: b.id ?? `pl-${i}`, plan: planText }}
          onResponse={handlers.onPlanResponse}
        />
      );
    }
    const resolved = derivePlanResolution(result);
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: { content: result.content, isError: result.isError },
      // A user rejection deliberately ends the review but is still a valid
      // decision. Only unclassified/validation failures render as tool errors.
      status: resolved === 'validation_error' ? 'error' : 'done',
    };
    return (
      <ToolCallBlock key={`pl-${b.id}-${i}`} call={tc}>
        <PlanPromptView
          plan={{ id: b.id ?? `pl-${i}`, plan: planText, resolved }}
          onResponse={noopPlanResponse}
        />
      </ToolCallBlock>
    );
  }

  if (b.name === 'submit_tasks' || (b.name === 'task_list' && taskListIsApprove(b.input))) {
    // Always render the rich TaskListReview for submit_tasks / task_list(approve)
    // tool calls (pending OR resolved). When the run already completed and we
    // have a tool_result, the resolved state hides the action buttons but keeps
    // the readable list. This avoids dumping a giant raw JSON tool_use block on
    // the user when they reopen an old session.
    //
    // The session keeps ONE current task projection (latest approve list wins),
    // so only the ACTIVE card (matching activeTasksToolUseId) overlays the live
    // `tasksState` for runtime status; superseded cards render their own frozen
    // tool_use.input snapshot. See deriveTaskCardState for the resolved logic.
    // task_list(approve) carries items under `items`; submit_tasks under `tasks`.
    const inp = (b.input ?? {}) as { summary?: string; tasks?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> };
    const rawTaskItems = Array.isArray(inp.items) ? inp.items : Array.isArray(inp.tasks) ? inp.tasks : [];
    const frozenTasks: StreamTask[] = rawTaskItems.map((t, ti) => ({
      id: String(t.id ?? `alias_${ti + 1}`),
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
    const isActiveTaskCard = !!activeTasksToolUseId && b.id === activeTasksToolUseId;
    const { tasks, resolved: resolvedStatus } = deriveTaskCardState({
      isActive: isActiveTaskCard,
      frozenTasks,
      tasksState,
      result,
    });
    return (
      <TaskListReview
        key={`tl-${b.id}-${i}`}
        prompt={{
          tool_use_id: b.id ?? `tl-${i}`,
          summary: (isActiveTaskCard && tasksState?.summary) || String(inp.summary ?? ''),
          tasks,
          version: 1,
          resolved: resolvedStatus,
        }}
        onResponse={handlers.onTasksResponse}
      />
    );
  }

  if (b.name === 'ask_user') {
    const inp = (b.input ?? {}) as {
      question?: string;
      header?: string;
      options?: Array<{ label: string; value: string }>;
      allow_freeform?: boolean;
      multi_select?: boolean;
    };
    if (!result) {
      return (
        <QuestionPromptView
          key={`qq-${b.id}-${i}`}
          question={{
            id: b.id ?? `q-${i}`,
            question: String(inp.question ?? ''),
            header: inp.header,
            options: inp.options,
            allowFreeform: Boolean(inp.allow_freeform),
            multiSelect: Boolean(inp.multi_select),
          }}
          onAnswer={handlers.onAnswer}
        />
      );
    }
    // Answered → collapsed rich block. Result text is `User answered: <answer>`.
    const answer = result.content.replace(/^User answered:\s*/, '');
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: { content: result.content, isError: result.isError },
      status: result.isError ? 'error' : 'done',
    };
    return (
      <ToolCallBlock key={`qq-${b.id}-${i}`} call={tc}>
        <QuestionPromptView
          question={{
            id: b.id ?? `q-${i}`,
            question: String(inp.question ?? ''),
            header: inp.header,
            options: inp.options,
            allowFreeform: Boolean(inp.allow_freeform),
            multiSelect: Boolean(inp.multi_select),
            resolved: answer,
          }}
          onAnswer={noopAnswer}
        />
      </ToolCallBlock>
    );
  }

  if (b.name === 'decision_gate') {
    const inp = (b.input ?? {}) as {
      header?: string;
      questions?: Array<{
        id?: string;
        header?: string;
        question?: string;
        multi_select?: boolean;
        options?: Array<{ label?: string; value?: string; summary?: string; tradeoffs?: string }>;
      }>;
      allow_freeform?: boolean;
    };
    const questions: DecisionQuestion[] = (Array.isArray(inp.questions) ? inp.questions : []).map((q, qi) => ({
      id: String(q.id ?? `q_${qi}`),
      header: q.header,
      question: String(q.question ?? ''),
      multiSelect: Boolean(q.multi_select),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
        label: String(o.label ?? ''),
        value: String(o.value ?? ''),
        summary: o.summary,
        tradeoffs: o.tradeoffs,
      })),
    }));
    const base = { id: b.id ?? `dg-${i}`, header: inp.header, questions, allowFreeform: Boolean(inp.allow_freeform) };
    if (!result) {
      return (
        <DecisionGateView
          key={`dg-${b.id}-${i}`}
          decision={base}
          onConfirm={handlers.onDecide ?? noopDecide}
        />
      );
    }
    const resolved = reconstructDecisionAnswers(result.content, questions);
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: { content: result.content, isError: result.isError },
      status: result.isError ? 'error' : 'done',
    };
    return (
      <ToolCallBlock key={`dg-${b.id}-${i}`} call={tc}>
        <DecisionGateView decision={{ ...base, resolved }} onConfirm={noopDecide} />
      </ToolCallBlock>
    );
  }

  // submit_spec (SDD mode): same live-vs-history split as submit_plan. Pending →
  // interactive SpecPromptView; answered → collapsed rich block (no raw JSON).
  if (b.name === 'submit_spec') {
    const inp = (b.input ?? {}) as { name?: string; body?: string };
    const name = String(inp.name ?? '');
    const body = String(inp.body ?? '');
    if (!result) {
      return (
        <SpecPromptView
          key={`sp-${b.id}-${i}`}
          spec={{ id: b.id ?? `sp-${i}`, name, body, spec_path: '' }}
          onResponse={handlers.onSpecResponse ?? noopSpecResponse}
        />
      );
    }
    const resolved: 'approved' | 'rejected' = result.content.startsWith('Spec approved')
      ? 'approved'
      : 'rejected';
    // The approved-result text embeds the path: "Spec approved by user at <path>."
    const specPath = /Spec approved by user at (.+?)\./.exec(result.content)?.[1] ?? '';
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: { content: result.content, isError: result.isError },
      status: result.isError ? 'error' : 'done',
    };
    return (
      <ToolCallBlock key={`sp-${b.id}-${i}`} call={tc}>
        <SpecPromptView
          spec={{ id: b.id ?? `sp-${i}`, name, body, spec_path: specPath, resolved }}
          onResponse={noopSpecResponse}
        />
      </ToolCallBlock>
    );
  }

  // todo_write / update_todo: render the checklist instead of raw JSON. Both
  // tools emit the same list text in the result; parse that. Collapsed by
  // default like the other rich history blocks.
  if (
    b.name === 'todo_write' ||
    b.name === 'update_todo' ||
    (b.name === 'task_list' && !taskListIsApprove(b.input))
  ) {
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: result
        ? { content: result.content, isError: result.isError }
        : undefined,
      status: result ? (result.isError ? 'error' : 'done') : 'running',
    };
    if (result && !result.isError) {
      return (
        <ToolCallBlock key={`td-${b.id}-${i}`} call={tc}>
          <TodoWriteBlock text={result.content} />
        </ToolCallBlock>
      );
    }
    // No result yet, or an error → generic block (nothing rich to show).
    return <ToolCallBlock key={`td-${b.id}-${i}`} call={tc} />;
  }

  // spawn_agents: render the rich parallel-agents group instead of raw JSON.
  // The tool is named `spawn_agent` (singular); it dispatches 1 or N agents.
  // (`spawn_agents` kept for any legacy persisted data.)
  if (b.name === 'spawn_agent' || b.name === 'spawn_agents') {
    const group = parsePersistedAgentsGroup(b.input, result, b.id);
    if (group) {
      return (
        <AgentsGroupBlock
          key={`ag-${b.id}-${i}`}
          group={group}
          resultSource={
            sessionId && b.id
              ? {
                  sessionId,
                  toolUseId: b.id,
                  input: b.input,
                  isTruncated: Boolean(result?.truncated),
                }
              : undefined
          }
        />
      );
    }
  }

  // Review tools: render the findings list instead of a raw text dump.
  if ((b.name === 'self_review' || b.name === 'review_subordinate_work') && result && !result.isError) {
    const tc: ToolCallEvent = {
      id: b.id ?? '',
      name: b.name ?? '',
      input: b.input,
      result: { content: result.content, isError: result.isError },
      status: 'done',
    };
    return (
      <ToolCallBlock key={`rv-${b.id}-${i}`} call={tc}>
        <SelfReviewBlock text={result.content} />
      </ToolCallBlock>
    );
  }

  if (b.name === 'execute_tasks' && result && !result.isError) {
    const parsedRun = parseExecuteTasksResult(result.content);
    if (parsedRun) {
      return <TaskExecutionBlock key={`trp-${b.id}-${i}`} run={parsedRun} defaultOpen={false} />;
    }
  }

  // workflow (Ultra): rebuild the DAG card from the persisted result text.
  if (b.name === 'workflow' && result && !result.isError) {
    const parsedWorkflow = parseWorkflowResult(result.content);
    if (parsedWorkflow) {
      return <WorkflowBlock key={`wfp-${b.id}-${i}`} run={parsedWorkflow} defaultOpen={false} />;
    }
  }

  const tc: ToolCallEvent = {
    id: b.id ?? '',
    name: b.name ?? '',
    input: b.input,
    result: result
      ? {
          content: result.content,
          isError: result.isError,
          ...(result.image ? { image: result.image } : {}),
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.originalLength != null ? { originalLength: result.originalLength } : {}),
        }
      : undefined,
    status: result ? (result.isError ? 'error' : 'done') : 'running',
  };
  // Goal tools get a richer block — they're session-wide events that the
  // generic collapsed ToolCallBlock makes too easy to miss.
  if (isGoalTool(tc.name)) {
    return <GoalCallBlock key={`gl-${b.id}-${i}`} call={tc} />;
  }
  // edit_file / multi_edit / write_file / create_file / apply_patch → file-first
  // block. Persisted history never carries approvals (live-only), so no handler.
  if (isEditTool(tc.name)) {
    return <FileEditBlock key={`fe-${b.id}-${i}`} call={tc} />;
  }
  return <ToolCallBlock key={`tu-${b.id}-${i}`} call={tc} sessionId={sessionId} />;
}

/**
 * Inline image preview (300px wide) that opens a fullscreen modal on click.
 * Used for assistant-emitted images (server-managed image_generation results).
 */
function GeneratedImageBlock({ mediaType, base64 }: { mediaType: string; base64: string }) {
  const [open, setOpen] = useState(false);
  if (!base64) return null;
  const src = `data:${mediaType};base64,${base64}`;
  return (
    <>
      <div className="my-2">
        <img
          src={src}
          alt="Generated"
          width={300}
          onClick={() => setOpen(true)}
          className="rounded border border-border cursor-zoom-in hover:opacity-90 transition-opacity"
        />
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 cursor-zoom-out"
          onClick={() => setOpen(false)}
          role="button"
          tabIndex={-1}
        >
          <img
            src={src}
            alt="Generated (full size)"
            className="max-w-full max-h-full rounded shadow-xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}


/** Collapsible thinking block — shows model reasoning, like Gemini/Claude. */
function ThinkingBlockView({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const displayText = cleanThinkingMarkdown(text);
  const previewText = thinkingPreviewText(text);
  const preview = previewText.length > 80 ? previewText.slice(0, 80) + '...' : previewText;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Brain className="h-3.5 w-3.5" />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{t('messages.thinking')}</span>
        {!open && <span className="italic truncate max-w-[300px]">{preview}</span>}
      </button>
      {open && (
        <div className="mt-1 ml-5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 max-h-[40vh] overflow-y-auto">
          <Markdown
            text={displayText}
            className="text-xs leading-5 text-muted-foreground italic prose-p:my-1 prose-strong:text-muted-foreground prose-code:text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
}
