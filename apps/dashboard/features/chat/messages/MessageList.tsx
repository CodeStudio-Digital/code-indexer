import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, ChevronUp, History, ScrollText } from 'lucide-react';
import type { AssistantTurn } from '../../../hooks/useAgentStream.js';
import { Alert, AlertDescription } from '../../../components/ui/alert.js';
import { cn } from '../../../lib/utils.js';
import { INITIAL_PAGE_SIZE, LOAD_MORE_SIZE } from '../constants.js';
import type { PersistedTasksState, PromptHandlers, SessionData } from '../types.js';
import { groupMessages } from '../utils.js';
import { AssistantBubble } from './AssistantBubble.js';
import { GroupedToolBubble } from './GroupedToolBubble.js';
import { MessageView } from './MessageView.js';
import { renderStreamBlock } from './renderStreamBlock.js';
import { PreflightBlock } from './PreflightBlock.js';

interface MessageListProps {
  sessionData: SessionData | null;
  currentTurn: AssistantTurn | null;
  streaming: boolean;
  /** Set while the blocking preflight runs on a fresh first message. Optional —
   *  call sites that don't surface the indicator (e.g. the editor rail) omit it. */
  preflight?: { startedAt: number } | null;
  doneReason: string | null;
  error: string | null;
  liveTurnDuplicatedInHistory: boolean;
  fallbackProviderId: string;
  tasksState: PersistedTasksState | null;
  handlers: PromptHandlers;
  /** Fetch earlier messages from the backend. Returns count of rows loaded (0 = nothing more).
   *  `includeArchived` crosses a "summarize & clear" boundary to reveal hidden history. */
  onLoadEarlier?: (beforeId: number, limit?: number, includeArchived?: boolean) => Promise<number>;
}

/**
 * Distinct, collapsible card for the synthetic message written by a manual
 * "summarize & clear". Styled apart from a normal user bubble so the fresh
 * transcript reads as "here's the summary of what came before", not "the user
 * pasted a wall of text".
 */
function SummaryCard({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        <ScrollText className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 ml-auto transition-transform', open ? '' : '-rotate-90')} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs whitespace-pre-wrap break-words text-foreground/80 leading-relaxed">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * Persisted history list. Memoized so that the token-by-token updates to
 * `currentTurn` in the parent do NOT re-render every past message (and every
 * ToolCallBlock inside them). Rerenders only when the session data itself
 * changes (refetch after message_complete).
 */
const PersistedMessages = React.memo(function PersistedMessages({
  sessionData,
  handlers,
  tasksState,
  scrollContainerRef,
  streaming,
  onLoadEarlier,
}: {
  sessionData: SessionData;
  handlers: PromptHandlers;
  tasksState: PersistedTasksState | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  streaming: boolean;
  onLoadEarlier?: (beforeId: number, limit?: number, includeArchived?: boolean) => Promise<number>;
}) {
  // Build tool-result map once per sessionData change. Tool-produced images
  // (preview_screenshot / view_image) are rendered as their own image bubble
  // (the synthetic user message), not paired inline here — that path proved
  // fragile; the attachment renderer is the reliable one.
  const { t } = useTranslation('chat');
  const resultsById = useMemo(() => {
    const m = new Map<string, { content: string; isError: boolean }>();
    // Seed from the coder_tool_calls audit fallback FIRST so any real
    // tool_result block below overrides it. This covers tool calls whose tool
    // message was never persisted (pre-fix sessions where a mid-run compaction
    // dropped it) — without it they render as a perpetual loading spinner.
    for (const tr of sessionData.tool_results ?? []) {
      const suffix =
        tr._truncated && tr._originalLength
          ? `\n\n… [truncated for transport — ${tr._originalLength - (tr.content?.length ?? 0)} more chars in DB]`
          : '';
      m.set(tr.tool_use_id, { content: (tr.content ?? '') + suffix, isError: Boolean(tr.is_error) });
    }
    for (const msg of sessionData.messages) {
      if (msg.role !== 'tool') continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const suffix =
            b._truncated && b._originalLength
              ? `\n\n… [truncated for transport — ${b._originalLength - (b.content?.length ?? 0)} more chars in DB]`
              : '';
          m.set(b.tool_use_id, {
            content: (b.content ?? '') + suffix,
            isError: Boolean(b.is_error),
          });
        }
      }
    }
    return m;
  }, [sessionData]);

  // Group messages into visual groups
  const groups = useMemo(
    () => groupMessages(sessionData.messages, sessionData.message_rows),
    [sessionData],
  );

  // The session keeps ONE coder_tasks_state row (latest submit_tasks wins), so
  // only the most recent submit_tasks tool_use block may overlay the live
  // `tasksState`. Older/superseded cards render their own frozen snapshot.
  // Gated on a non-empty row: after `archive_task_list` clears it there is no
  // active card and every card falls back to its frozen input.
  const activeTasksToolUseId = useMemo<string | null>(() => {
    if (!tasksState?.tasks?.length) return null;
    let last: string | null = null;
    for (const msg of sessionData.messages) {
      if (msg.role !== 'assistant') continue;
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.name === 'submit_tasks' && b.id) last = b.id;
      }
    }
    return last;
  }, [sessionData, tasksState]);

  // During streaming with many groups, only render the tail to keep DOM light.
  const [renderCap, setRenderCap] = useState<number | null>(null);
  const sessionIdRef = useRef(sessionData.session.id);
  useEffect(() => {
    if (sessionIdRef.current !== sessionData.session.id) {
      sessionIdRef.current = sessionData.session.id;
      setRenderCap(null);
    }
  }, [sessionData.session.id]);
  useEffect(() => {
    if (streaming && groups.length > 80 && renderCap === null) {
      setRenderCap(INITIAL_PAGE_SIZE);
    }
    if (!streaming && renderCap !== null) {
      setRenderCap(null);
    }
  }, [streaming, groups.length, renderCap]);

  const displayGroups = renderCap !== null && groups.length > renderCap
    ? groups.slice(-renderCap)
    : groups;

  // Summary-boundary aware pagination. `total_messages` counts only VISIBLE
  // rows (above a "summarize & clear" boundary); `archived_count` is what's
  // hidden below it. The user reveals the archive explicitly, after which
  // normal pagination continues across the boundary (includeArchived=true).
  const totalMessages = sessionData.total_messages ?? sessionData.message_rows.length;
  const archivedCount = sessionData.archived_count ?? 0;
  const fullTotal = totalMessages + archivedCount;
  const loadedCount = sessionData.message_rows.length;
  const [revealArchived, setRevealArchived] = useState(false);
  const revealArchivedRef = useRef(false);
  const visibleHasEarlier = totalMessages > loadedCount;
  const hasEarlier = visibleHasEarlier || (revealArchived && loadedCount < fullTotal);
  const canRevealArchived = !visibleHasEarlier && archivedCount > 0 && !revealArchived;
  const displayTotal = revealArchived ? fullTotal : totalMessages;

  // Scroll preservation when loading earlier messages
  const prevScrollHeightRef = useRef<number>(0);
  const loadingEarlierRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Sync guard refs — React state batching can allow multiple observer
  // callbacks to slip through before `loadingMore` is committed. Refs
  // update synchronously and prevent duplicate requests.
  const loadingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const [exhausted, setExhausted] = useState(false);

  // Reset exhausted + archived-reveal flags when switching sessions.
  useEffect(() => {
    exhaustedRef.current = false;
    setExhausted(false);
    revealArchivedRef.current = false;
    setRevealArchived(false);
  }, [sessionData.session.id]);

  const handleLoadEarlier = useCallback(async () => {
    if (!onLoadEarlier || loadingRef.current || exhaustedRef.current) return;
    const earliestId = sessionData.message_rows[0]?.id;
    if (!earliestId) return;
    loadingRef.current = true;
    const el = scrollContainerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    loadingEarlierRef.current = true;
    setLoadingMore(true);
    try {
      const count = await onLoadEarlier(earliestId, LOAD_MORE_SIZE, revealArchivedRef.current);
      if (count === 0) {
        // Backend returned nothing — stop polling forever for this session.
        exhaustedRef.current = true;
        setExhausted(true);
      }
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [onLoadEarlier, sessionData.message_rows, scrollContainerRef]);

  // Cross the "summarize & clear" boundary on explicit user request, then let
  // the normal infinite-scroll continue pulling archived pages.
  const handleRevealArchived = useCallback(() => {
    revealArchivedRef.current = true;
    setRevealArchived(true);
    void handleLoadEarlier();
  }, [handleLoadEarlier]);

  // After new messages are prepended, restore scroll position
  useLayoutEffect(() => {
    if (!loadingEarlierRef.current) return;
    loadingEarlierRef.current = false;
    const el = scrollContainerRef.current;
    if (!el) return;
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) el.scrollTop += delta;
  }, [sessionData.messages.length, scrollContainerRef]);

  // Stable ref to the latest handleLoadEarlier — avoids re-creating the
  // IntersectionObserver every time the callback identity changes.
  const handleRef = useRef(handleLoadEarlier);
  handleRef.current = handleLoadEarlier;

  // Infinite scroll: auto-load when a sentinel element near the top becomes
  // visible. The observer is only created once per hasEarlier/exhausted
  // change and uses refs for all guards to avoid stale closures.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasEarlier || !onLoadEarlier || exhaustedRef.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current && !exhaustedRef.current) {
          void handleRef.current();
        }
      },
      { root: scrollContainerRef.current, rootMargin: '200px 0px 0px 0px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasEarlier, exhausted, onLoadEarlier, scrollContainerRef]);

  const providerId = sessionData.session.provider;

  return (
    <>
      {/* Sentinel for infinite scroll — triggers auto-load when near top */}
      {hasEarlier && !exhausted && <div ref={sentinelRef} className="h-px" />}
      {hasEarlier && !exhausted && (
        <div className="flex items-center justify-center gap-2 w-full py-2">
          <button
            type="button"
            onClick={handleLoadEarlier}
            disabled={loadingMore}
            className="flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors disabled:opacity-50"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            {loadingMore ? 'Loading...' : 'Load earlier'}
          </button>
          <span className="text-[10px] text-muted-foreground/60">
            {loadedCount} of {displayTotal} loaded
          </span>
        </div>
      )}
      {canRevealArchived && (
        <div className="flex items-center justify-center w-full py-2">
          <button
            type="button"
            onClick={handleRevealArchived}
            disabled={loadingMore}
            className="flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors disabled:opacity-50"
          >
            <History className="h-3.5 w-3.5" />
            {loadingMore
              ? 'Loading...'
              : t('messages.showEarlierHistory', { count: archivedCount })}
          </button>
        </div>
      )}
      {exhausted && loadedCount < fullTotal && (
        <div className="text-center py-1.5 text-[10px] text-muted-foreground/50">
          All available messages loaded
        </div>
      )}
      {sessionData.session.compaction_summary && (
        <SummaryCard text={sessionData.session.compaction_summary} label={t('messages.summaryCard')} />
      )}
      {displayGroups.map((g, gi) => {
        const groupKey = g.kind === 'user'
          ? `u-${g.messageId ?? gi}`
          : `a-${g.messageIds[0] ?? gi}`;

        if (g.kind === 'user') {
          return (
            <MessageView
              key={groupKey}
              message={g.message}
              messageId={g.messageId}
              sessionId={sessionData.session.id}
              toolResultsById={resultsById}
              usage={g.usage}
              providerId={providerId}
              onAnswer={handlers.onAnswer}
              onPlanResponse={handlers.onPlanResponse}
              onTasksResponse={handlers.onTasksResponse}
              onDecide={handlers.onDecide}
              onFork={handlers.onFork}
              onRollback={handlers.onRollback}
              tasksState={tasksState}
            />
          );
        }

        // Single text-bearing assistant message → original MessageView (backward compat)
        if (g.hasText && g.messages.length === 1) {
          return (
            <MessageView
              key={groupKey}
              message={g.messages[0]}
              messageId={g.messageIds[0]}
              sessionId={sessionData.session.id}
              toolResultsById={resultsById}
              usage={g.usages[0]}
              providerId={providerId}
              onAnswer={handlers.onAnswer}
              onPlanResponse={handlers.onPlanResponse}
              onTasksResponse={handlers.onTasksResponse}
              onDecide={handlers.onDecide}
              onFork={handlers.onFork}
              onRollback={handlers.onRollback}
              tasksState={tasksState}
              activeTasksToolUseId={activeTasksToolUseId}
            />
          );
        }

        // Grouped assistant bubble (multiple tool-only turns or single tool-only turn)
        return (
          <GroupedToolBubble
            key={groupKey}
            group={g}
            toolResultsById={resultsById}
            providerId={providerId}
            handlers={handlers}
            tasksState={tasksState}
            activeTasksToolUseId={activeTasksToolUseId}
          />
        );
      })}
    </>
  );
});

/**
 * Live streaming turn. Isolated into its own component so that React's
 * reconciliation only touches the streaming bubble on each token flush,
 * leaving <PersistedMessages /> alone.
 */
const LiveTurn = React.memo(function LiveTurn({
  currentTurn,
  streaming,
  preflight,
  providerId,
  handlers,
  hidden,
}: {
  currentTurn: AssistantTurn | null;
  streaming: boolean;
  preflight: { startedAt: number } | null;
  providerId: string;
  handlers: PromptHandlers;
  hidden: boolean;
}) {
  const hasBlocks = !!currentTurn && currentTurn.blocks.length > 0 && !hidden;
  if (hasBlocks) {
    return (
      <AssistantBubble providerId={providerId} streaming={streaming}>
        {currentTurn!.blocks.map((b, i) => renderStreamBlock(b, i, handlers))}
      </AssistantBubble>
    );
  }
  // Blocking preflight on a fresh first message — labelled indicator instead of
  // the bare spinner, until the first SSE event clears it.
  if (preflight && !hidden) {
    return (
      <AssistantBubble providerId={providerId} streaming>
        <PreflightBlock startedAt={preflight.startedAt} />
      </AssistantBubble>
    );
  }
  if (streaming) {
    return (
      <AssistantBubble providerId={providerId} streaming>
        <div className="dot-pulse text-muted-foreground">
          <span />
          <span />
          <span />
        </div>
      </AssistantBubble>
    );
  }
  return null;
});

export function MessageList({
  sessionData,
  currentTurn,
  streaming,
  preflight = null,
  doneReason,
  error,
  liveTurnDuplicatedInHistory,
  fallbackProviderId,
  tasksState,
  handlers,
  onLoadEarlier,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user scrolled up — if so, don't yank them back to the
  // bottom on every token. Also use instant scroll during streaming; a smooth
  // animation per token fights with layout and amplifies the jank.
  const stickToBottomRef = useRef(true);
  const sessionIdRef = useRef<number | null>(null);
  // Detect user-initiated scroll-up via wheel/touch — not generic scroll
  // events, which also fire on programmatic scrolls & layout reflows and
  // can falsely flip stickToBottomRef off when the chat grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const checkBottom = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 80) stickToBottomRef.current = true;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        stickToBottomRef.current = false;
      } else {
        requestAnimationFrame(checkBottom);
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchStartY + 5) {
        stickToBottomRef.current = false;
      } else if (y < touchStartY - 5) {
        requestAnimationFrame(checkBottom);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // When the session changes, force the sticky-bottom ref back on so the
  // fresh session lands at the latest message. Without this, a user that
  // had scrolled up in a previous session would stay "unstuck" across the
  // switch and land at the top of the new one.
  useEffect(() => {
    const nextId = sessionData?.session.id ?? null;
    if (sessionIdRef.current !== nextId) {
      sessionIdRef.current = nextId;
      stickToBottomRef.current = true;
    }
  }, [sessionData?.session.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    // Double-RAF: on mobile the content often lays out *after* the effect
    // runs (fonts, images, code blocks, virtual keyboard resize). Scrolling
    // once on the synchronous pass lands at scrollHeight=0 and sticks the
    // user at the top — the second frame runs after layout has settled.
    const scroll = () => el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
    scroll();
    const raf1 = requestAnimationFrame(() => {
      scroll();
      const raf2 = requestAnimationFrame(scroll);
      (scroll as unknown as { _raf2?: number })._raf2 = raf2;
    });
    return () => {
      cancelAnimationFrame(raf1);
      const raf2 = (scroll as unknown as { _raf2?: number })._raf2;
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [sessionData, currentTurn, streaming]);

  const providerId = sessionData?.session.provider ?? fallbackProviderId;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 py-5 space-y-5 min-h-0"
    >
      {sessionData && (
        <PersistedMessages
          sessionData={sessionData}
          handlers={handlers}
          tasksState={tasksState}
          scrollContainerRef={scrollRef}
          streaming={streaming}
          onLoadEarlier={onLoadEarlier}
        />
      )}

      <LiveTurn
        currentTurn={currentTurn}
        streaming={streaming}
        preflight={preflight}
        providerId={providerId}
        handlers={handlers}
        hidden={liveTurnDuplicatedInHistory}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {doneReason && !streaming && (
        <div className="text-[10px] text-center py-1">
          <span className="text-muted-foreground">— {doneReason} —</span>
        </div>
      )}
    </div>
  );
}
