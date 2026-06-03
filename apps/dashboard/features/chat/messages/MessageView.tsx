import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Brain, ChevronDown, ChevronRight, FileText, GitBranch, ImageIcon, Loader2, Paperclip, Sparkles, User } from 'lucide-react';
import type { AgentsGroup, ToolCallEvent } from '../../../hooks/useAgentStream.js';
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
import { AgentsGroupBlock } from './AgentsGroupBlock.js';
import { CopyMarkdownButton } from './CopyMarkdownButton.js';
import { Markdown } from './Markdown.js';
import { TaskExecutionBlock, parseExecuteTasksResult } from './TaskExecutionBlock.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { GoalCallBlock, isGoalTool } from './GoalCallBlock.js';

interface MessageViewProps {
  message: PersistedMessage;
  /** DB id of the persisted message row — used to fork from a user turn. */
  messageId?: number;
  /** Session id — needed to lazy-fetch attachment base64 stripped from the
   *  list payload (see sessions.ts trimMessageBlocks). */
  sessionId?: number;
  toolResultsById: Map<string, { content: string; isError: boolean; image?: { mediaType: string; base64: string } }>;
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
    prev.sessionId === next.sessionId &&
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
  sessionId,
  toolResultsById,
  usage,
  providerId,
  onAnswer,
  onPlanResponse,
  onTasksResponse,
  onFork,
  tasksState,
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
      <div className="flex-1 min-w-0 max-w-[100%]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
          <span>{t('messages.assistant')}{tokenBadge}</span>
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
  sessionId,
  messageId,
  tokenBadge,
  onFork,
}: {
  message: PersistedMessage;
  sessionId?: number;
  messageId?: number;
  tokenBadge: React.ReactNode;
  onFork?: () => void;
}) {
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
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

  return (
    <div className="flex gap-3 items-start justify-end group/user group/msg">
      <div className="flex-1 min-w-0 max-w-[100%] flex flex-col items-end">
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
          {text && <CopyMarkdownButton text={text} />}
          <span>you{tokenBadge}</span>
        </div>
        {appliedSkills.length > 0 && (
          <div
            className="flex flex-wrap gap-1 mb-1 justify-end max-w-[100%]"
            aria-label="Skills applied to this turn"
          >
            {appliedSkills.map((id) => (
              <span
                key={id}
                title={id}
                className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-violet-600 dark:text-violet-300"
              >
                <Sparkles className="h-2.5 w-2.5" />
                <span className="max-w-[140px] truncate">{id}</span>
              </span>
            ))}
          </div>
        )}
        <div className="rounded-2xl rounded-tr-sm bg-gray-50 dark:bg-gray-900 border border-primary/40 text-foreground px-4 py-2.5 shadow-sm max-h-[60vh] max-w-[100%] overflow-y-auto">
          {text && (
            <div className="text-sm">
              <Markdown text={text} />
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
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
      </div>
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="bg-muted text-muted-foreground">
          <User className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
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
        className="relative rounded-lg border border-primary-foreground/20 overflow-hidden cursor-zoom-in hover:opacity-90 transition-opacity"
        title={hasData ? 'Open preview' : 'Load preview'}
      >
        {src ? (
          <img src={src} alt="attachment" className="max-h-48 block" />
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 w-32 h-32 bg-muted/50 text-muted-foreground">
            {loading || pendingOpen ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <ImageIcon className="h-6 w-6" />
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
  const src = hasData ? `data:${block.mediaType};base64,${block.base64}` : null;

  useEffect(() => {
    if (pendingOpen && src) {
      window.open(src, '_blank', 'noopener,noreferrer');
      setPendingOpen(false);
    }
  }, [pendingOpen, src]);

  const handleClick = () => {
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
      title={hasData ? 'Open document' : 'Load document'}
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

export function renderAssistantBlock(
  b: ContentBlock,
  i: number,
  handlers: PromptHandlers,
  toolResultsById: Map<string, { content: string; isError: boolean; image?: { mediaType: string; base64: string } }>,
  tasksState: PersistedTasksState | null | undefined,
) {
  if (b.type === 'thinking') {
    return <ThinkingBlockView key={`think-${i}`} text={b.text ?? ''} />;
  }
  if (b.type === 'text') {
    // deepThink — text blocks injected by the runner carry the
    // `<thinking data-source="aux" data-model="…">` envelope. Render
    // them as a distinct emerald block so the user sees both the
    // aux's reasoning AND the main model's reply in the transcript.
    const preThink = parsePreThinkText(b.text ?? '');
    if (preThink) {
      return <PersistedPreThinkBlock key={`pt-${i}`} model={preThink.model} text={preThink.text} empty={preThink.empty} />;
    }
    return (
      <div key={i} className="text-sm text-foreground/90">
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
      : (Array.isArray(inp.tasks) ? inp.tasks : []).map((t, ti) => ({
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

  // spawn_agents: render the rich parallel-agents group instead of raw JSON.
  if (b.name === 'spawn_agents') {
    const group = parsePersistedAgentsGroup(b.input, result);
    if (group) {
      return <AgentsGroupBlock key={`ag-${b.id}-${i}`} group={group} />;
    }
  }

  if (b.name === 'execute_tasks' && result && !result.isError) {
    const parsedRun = parseExecuteTasksResult(result.content);
    if (parsedRun) {
      return <TaskExecutionBlock key={`trp-${b.id}-${i}`} run={parsedRun} defaultOpen={false} />;
    }
  }

  const tc: ToolCallEvent = {
    id: b.id ?? '',
    name: b.name ?? '',
    input: b.input,
    result: result
      ? { content: result.content, isError: result.isError, ...(result.image ? { image: result.image } : {}) }
      : undefined,
    status: result ? (result.isError ? 'error' : 'done') : 'running',
  };
  // Goal tools get a richer block — they're session-wide events that the
  // generic collapsed ToolCallBlock makes too easy to miss.
  if (isGoalTool(tc.name)) {
    return <GoalCallBlock key={`gl-${b.id}-${i}`} call={tc} />;
  }
  return <ToolCallBlock key={`tu-${b.id}-${i}`} call={tc} />;
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

/**
 * Detects the auxiliary pre-think marker injected by the runner when
 * `deepThink` is on. Format (see runner.ts wire of deepThink):
 *   <thinking data-source="aux" data-model="MODEL_ID" [data-empty="true"]>
 *   {pre-thought text}
 *   </thinking>
 *
 * `data-empty="true"` flags turns where the auxiliary was billed but
 * returned no output text (reasoning-model burned the whole output budget
 * on reasoning tokens). The body in that case is an explanatory note that
 * the UI surfaces as a warning rather than as actual reasoning.
 *
 * Returns null when the text is not a pre-think block.
 */
const PRE_THINK_RE = /^<thinking\s+data-source="aux"(?:\s+data-model="([^"]*)")?(?:\s+data-empty="([^"]*)")?\s*>\s*([\s\S]*?)\s*<\/thinking>\s*$/;

function parsePreThinkText(raw: string): { model: string; text: string; empty: boolean } | null {
  if (!raw || !raw.startsWith('<thinking data-source="aux"')) return null;
  const m = PRE_THINK_RE.exec(raw.trim());
  if (!m) return null;
  return {
    model: m[1] ?? 'auxiliary',
    text: m[3] ?? '',
    empty: m[2] === 'true',
  };
}

/**
 * Persisted view of an auxiliary pre-think (deepThink). Distinct from
 * `ThinkingBlockView` (native reasoning, purple Brain) — this one is
 * emerald + Sparkles + model badge so the operator can see in the chat
 * transcript which model auxiliated and what it suggested. Collapsed by
 * default to keep old turns compact.
 */
function PersistedPreThinkBlock({ model, text, empty }: { model: string; text: string; empty: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
  // Empty: aux fired and was billed but returned no output text.
  // Show in amber (warning) instead of emerald so the operator notices,
  // and use a distinct preview line.
  const isEmpty = empty;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 text-xs transition-colors ${
          isEmpty
            ? 'text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300'
            : 'text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300'
        }`}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{isEmpty ? 'Pré-pensamento vazio' : 'Pré-pensamento'}</span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
            isEmpty
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
              : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20'
          }`}
        >
          {model}
        </span>
        {!open && (
          <span className="italic truncate max-w-[400px] text-muted-foreground">
            {isEmpty ? 'modelo gastou todo o budget em reasoning_tokens — clique para ver detalhes' : preview}
          </span>
        )}
      </button>
      {open && (
        <div
          className={`mt-1 ml-5 rounded-lg border border-dashed px-3 py-2 text-xs italic whitespace-pre-wrap max-h-[40vh] overflow-y-auto ${
            isEmpty
              ? 'border-amber-500/30 bg-amber-500/[0.04] text-amber-900 dark:text-amber-200'
              : 'border-emerald-500/30 bg-emerald-500/[0.04] text-emerald-900 dark:text-emerald-200'
          }`}
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** Collapsible thinking block — shows model reasoning, like Gemini/Claude. */
function ThinkingBlockView({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const preview = text.length > 80 ? text.slice(0, 80) + '...' : text;
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
        <div className="mt-1 ml-5 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic whitespace-pre-wrap max-h-[40vh] overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * Reconstruct an AgentsGroup from the persisted tool_use input + tool_result
 * so the rich AgentsGroupBlock renders instead of raw JSON on session reload.
 */
function parsePersistedAgentsGroup(
  input: Record<string, unknown> | undefined,
  result: { content: string; isError: boolean } | undefined,
): AgentsGroup | null {
  const agents = (input as { agents?: unknown[] })?.agents;
  if (!Array.isArray(agents) || agents.length === 0) return null;

  // Parse per-agent results from the combined result text.
  // Format: "### Agent N: <label>\n[reason=... tools=N input=N output=N]\n<summary>"
  const agentResults = new Map<number, {
    provider?: string;
    model?: string;
    reason: string;
    tools: number;
    input: number;
    output: number;
    summary: string;
  }>();
  const groupProviderMatch = result?.content?.match(
    /\[parallel agents:[^\]]*provider=([^\s,\]]+)\s+model=([^\s,\]]+)/,
  );
  const groupProvider = groupProviderMatch?.[1];
  const groupModel = groupProviderMatch?.[2];
  if (result?.content) {
    const sections = result.content.split(/^---$/m);
    for (const section of sections) {
      const headerMatch = section.match(/###\s+Agent\s+(\d+):\s+(.+)/);
      if (!headerMatch) continue;
      const idx = parseInt(headerMatch[1], 10) - 1;
      const metaMatch = section.match(
        /\[(?:provider=([^\s\]]+)\s+model=([^\s\]]+)\s+)?reason=(\w+)\s+tools=(\d+)\s+input=(\d+)\s+output=(\d+)\]/,
      );
      const summaryStart = section.indexOf('\n', section.indexOf(']') + 1);
      const summary = summaryStart >= 0 ? section.slice(summaryStart).trim() : '';
      agentResults.set(idx, {
        provider: metaMatch?.[1],
        model: metaMatch?.[2],
        reason: metaMatch?.[3] ?? 'unknown',
        tools: parseInt(metaMatch?.[4] ?? '0', 10),
        input: parseInt(metaMatch?.[5] ?? '0', 10),
        output: parseInt(metaMatch?.[6] ?? '0', 10),
        summary,
      });
    }
  }

  const isCompleted = !!result;

  return {
    groupId: `persisted-${Date.now()}`,
    status: isCompleted ? 'completed' : 'running',
    provider: groupProvider,
    model: groupModel,
    totalUsage: isCompleted
      ? {
          input_tokens: Array.from(agentResults.values()).reduce((s, r) => s + r.input, 0),
          output_tokens: Array.from(agentResults.values()).reduce((s, r) => s + r.output, 0),
        }
      : undefined,
    agents: agents.map((a, i) => {
      const raw = a as { label?: string; task?: string };
      const parsed = agentResults.get(i);
      return {
        index: i,
        label: String(raw.label ?? `Agent ${i + 1}`),
        status: parsed
          ? parsed.reason === 'error'
            ? ('error' as const)
            : ('completed' as const)
          : isCompleted
            ? ('completed' as const)
            : ('pending' as const),
        toolCallCount: parsed?.tools ?? 0,
        provider: parsed?.provider ?? groupProvider,
        model: parsed?.model ?? groupModel,
        usage: parsed ? { input_tokens: parsed.input, output_tokens: parsed.output } : undefined,
        summary: parsed?.summary || undefined,
        error: parsed?.reason === 'error' ? parsed.summary : undefined,
      };
    }),
  };
}
