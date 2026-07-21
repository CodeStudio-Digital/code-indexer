import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronUp, History } from 'lucide-react';
import type { AssistantTurn } from '../../../hooks/useAgentStream.js';
import { Alert, AlertDescription } from '../../../components/ui/alert.js';
import { LOAD_MORE_SIZE } from '../constants.js';
import type { PersistedTasksState, PromptHandlers, SessionData } from '../types.js';
import {
  collectLatestPersistedInteractivePromptSignatures,
  groupMessages,
  liveTurnContinuesPersistedAssistant,
  mergeConsecutiveAssistantGroups,
  suppressPersistedAgentDuplicates,
  visibleLiveBlocks,
} from '../utils.js';
import { AssistantBubble } from './AssistantBubble.js';
import { GroupedToolBubble } from './GroupedToolBubble.js';
import { MessageView } from './MessageView.js';
import { renderStreamBlock } from './renderStreamBlock.js';
import { PreflightBlock } from './PreflightBlock.js';
import { SnapshotFilesProvider, type SnapshotActions } from './snapshot-files-context.js';
import { TurnFilesSummary } from './TurnFilesSummary.js';
import { computeTurnEditSummaries } from './turn-summaries.js';
import { filesFromEditToolCall, type EditFileRef } from './edit-tools.js';
import type { SnapshotFileSummary } from '../../snapshots/types.js';
import {
  ConversationChapterDivider,
  useConversationChapters,
} from './ConversationChapters.js';
import { loadedChapterMarkers } from './chapter-markers.js';

const EMPTY_FILES: Map<string, SnapshotFileSummary> = new Map();
const LOAD_EARLIER_SCROLL_THRESHOLD = 200;

/** Render only the transcript tail once it grows past this many groups —
 * streaming or idle. Mounting every group of a large idle session on open
 * froze the renderer; capped groups stay reachable via "load earlier". */
const RENDER_CAP_THRESHOLD = 80;
/** Tail size kept in the DOM while capped; also the local reveal step per
 * "load earlier" trigger before the backend is consulted. */
const RENDER_CAP = 120;

/** Direct scroll fallback for environments where IntersectionObserver does
 * not re-fire after the conversation moves between retained workbench
 * surfaces. Negative values cover elastic overscroll on touch devices. */
export function shouldLoadEarlierAtScrollTop(scrollTop: number): boolean {
  return scrollTop <= LOAD_EARLIER_SCROLL_THRESHOLD;
}

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
  /** Assistant tool_use ids already in persisted history. The live turn drops
   *  any gate/tool block whose id is here, so a paused gate (awaiting approval)
   *  isn't rendered twice — once persisted (above) and once live (below). */
  persistedToolUseIds: Set<string>;
  fallbackProviderId: string;
  tasksState: PersistedTasksState | null;
  handlers: PromptHandlers;
  /** Fetch earlier messages from the backend. Returns count of rows loaded (0 = nothing more).
   *  `includeArchived` crosses a "summarize & clear" boundary to reveal hidden history. */
  onLoadEarlier?: (beforeId: number | undefined, limit?: number, includeArchived?: boolean) => Promise<number>;
  /** Session-snapshot wiring for the file-edit blocks + per-turn "files changed"
   *  summary. Optional — mounts without snapshot support (e.g. the editor rail)
   *  degrade to plain file rows and skip the summary. */
  snapshotActions?: SnapshotActions | null;
  snapshotFiles?: Map<string, SnapshotFileSummary>;
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
  onChapterNavigate,
  liveAgentIdentityKey,
}: {
  sessionData: SessionData;
  handlers: PromptHandlers;
  tasksState: PersistedTasksState | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  streaming: boolean;
  onLoadEarlier?: (beforeId: number | undefined, limit?: number, includeArchived?: boolean) => Promise<number>;
  onChapterNavigate?: () => void;
  /** Stable primitive so token deltas do not invalidate the persisted tree. */
  liveAgentIdentityKey: string;
}) {
  // Build tool-result map once per sessionData change. Tool-produced images
  // (preview_screenshot / view_image) are rendered as their own image bubble
  // (the synthetic user message), not paired inline here — that path proved
  // fragile; the attachment renderer is the reliable one.
  const { t } = useTranslation('chat');
  const resultsById = useMemo(() => {
    const m = new Map<string, { content: string; isError: boolean; truncated?: boolean; originalLength?: number }>();
    // Seed from the coder_tool_calls audit fallback FIRST so any real
    // tool_result block below overrides it. This covers tool calls whose tool
    // message was never persisted (pre-fix sessions where a mid-run compaction
    // dropped it) — without it they render as a perpetual loading spinner.
    for (const tr of sessionData.tool_results ?? []) {
      m.set(tr.tool_use_id, {
        content: tr.content ?? '',
        isError: Boolean(tr.is_error),
        truncated: Boolean(tr._truncated),
        originalLength: tr._originalLength,
      });
    }
    for (const msg of sessionData.messages) {
      if (msg.role !== 'tool') continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          m.set(b.tool_use_id, {
            content: b.content ?? '',
            isError: Boolean(b.is_error),
            truncated: Boolean(b._truncated),
            originalLength: b._originalLength,
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
        // submit_tasks (legacy) and task_list (merged) both post the approve list.
        if (b.type === 'tool_use' && (b.name === 'submit_tasks' || b.name === 'task_list') && b.id) last = b.id;
      }
    }
    return last;
  }, [sessionData, tasksState]);

  // Above RENDER_CAP_THRESHOLD groups, only render the tail to keep DOM light —
  // streaming or idle (an idle session used to mount every group on open,
  // freezing the renderer). Derived during render (React's "adjust state on
  // prop change" pattern) instead of an effect so a heavy transcript is never
  // mounted uncapped even once; "load earlier" below expands the cap before
  // consulting the backend.
  const [renderCap, setRenderCap] = useState<number | null>(
    () => (groups.length > RENDER_CAP_THRESHOLD ? RENDER_CAP : null),
  );
  const [prevSessionId, setPrevSessionId] = useState(sessionData.session.id);
  if (prevSessionId !== sessionData.session.id) {
    // Session switched in place — recompute the cap for the new transcript.
    setPrevSessionId(sessionData.session.id);
    setRenderCap(groups.length > RENDER_CAP_THRESHOLD ? RENDER_CAP : null);
  } else if (renderCap === null && groups.length > RENDER_CAP_THRESHOLD) {
    setRenderCap(RENDER_CAP);
  }

  const cappedGroups = renderCap !== null && groups.length > renderCap
    ? groups.slice(-renderCap)
    : groups;
  const liveAgentIdentities = useMemo(
    () => (liveAgentIdentityKey ? JSON.parse(liveAgentIdentityKey) : []),
    [liveAgentIdentityKey],
  );
  const displayGroups = useMemo(
    () => mergeConsecutiveAssistantGroups(
      suppressPersistedAgentDuplicates(cappedGroups, liveAgentIdentities, resultsById),
    ),
    [cappedGroups, liveAgentIdentities, resultsById],
  );
  // True while already-loaded groups are hidden by the cap — drives the
  // "load earlier" affordance even when the backend has nothing more.
  const capHidesGroups = cappedGroups.length < groups.length;
  // Latest group count for handlers bound once per session (chapter navigate)
  // — avoids rebinding window listeners on every transcript growth.
  const groupsLengthRef = useRef(groups.length);
  groupsLengthRef.current = groups.length;

  const chapterIndex = useConversationChapters(sessionData.session.id);
  const [activeChapterId, setActiveChapterId] = useState<number | null>(null);
  useEffect(() => {
    let pendingMarkerObserver: MutationObserver | null = null;
    let pendingMarkerTimeout: number | null = null;
    const cancelPendingMarkerWait = () => {
      pendingMarkerObserver?.disconnect();
      pendingMarkerObserver = null;
      if (pendingMarkerTimeout != null) window.clearTimeout(pendingMarkerTimeout);
      pendingMarkerTimeout = null;
    };
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId: number;
        chapterId: number;
        endMessageId: number;
      }>).detail;
      if (!detail || detail.sessionId !== sessionData.session.id) return;
      onChapterNavigate?.();
      setActiveChapterId(detail.chapterId);
      const selector = `[data-chapter-id="${detail.chapterId}"]`;
      const scrollToMarker = (): boolean => {
        const marker = document
          .querySelector<HTMLElement>(selector);
        if (marker) {
          marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      };
      cancelPendingMarkerWait();
      if (scrollToMarker()) return;
      // The target may be loaded but hidden by the render cap — lift the cap
      // over the full transcript (plus headroom for the fetch below) so the
      // marker can mount; the observer below scrolls once it appears.
      setRenderCap((cap) => (cap === null ? null : Math.max(cap, groupsLengthRef.current + 160)));
      if (onLoadEarlier) {
        // The fetch can resolve before a large prepended transcript finishes
        // reconciling. Observe the chat container and scroll one paint after
        // the marker mounts, after React's scroll-preservation layout effect.
        const root = scrollContainerRef.current ?? document.body;
        pendingMarkerObserver = new MutationObserver(() => {
          if (!document.querySelector(selector)) return;
          cancelPendingMarkerWait();
          requestAnimationFrame(scrollToMarker);
        });
        pendingMarkerObserver.observe(root, { childList: true, subtree: true });
        pendingMarkerTimeout = window.setTimeout(cancelPendingMarkerWait, 8_000);
        void onLoadEarlier(detail.endMessageId + 1, 160, true)
          .then(() => {
            if (scrollToMarker()) cancelPendingMarkerWait();
          });
      }
    };
    const activate = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: number; chapterId: number }>).detail;
      if (!detail || detail.sessionId !== sessionData.session.id) return;
      setActiveChapterId(detail.chapterId);
    };
    window.addEventListener('coder:chapter-source', navigate);
    window.addEventListener('coder:chapter-active', activate);
    return () => {
      cancelPendingMarkerWait();
      window.removeEventListener('coder:chapter-source', navigate);
      window.removeEventListener('coder:chapter-active', activate);
    };
  }, [onChapterNavigate, onLoadEarlier, scrollContainerRef, sessionData.session.id]);
  useEffect(() => setActiveChapterId(null), [sessionData.session.id]);
  const chapterMarkers = useMemo(
    () => loadedChapterMarkers(chapterIndex.chapters, displayGroups),
    [chapterIndex.chapters, displayGroups],
  );

  // Per-turn "files changed" summary refs, keyed by each turn's last assistant
  // group index. Derived from persisted tool calls → survives scrollback/reload.
  const precedingDisplayRoundMessageId = useMemo(() => {
    let roundMessageId = sessionData.preceding_user_message_id ?? undefined;
    const skipped = groups.length - cappedGroups.length;
    for (let index = 0; index < skipped; index++) {
      const group = groups[index];
      if (group.kind === 'user') roundMessageId = group.messageId;
    }
    return roundMessageId;
  }, [cappedGroups.length, groups, sessionData.preceding_user_message_id]);
  const turnSummaries = useMemo(
    () => computeTurnEditSummaries(displayGroups, precedingDisplayRoundMessageId),
    [displayGroups, precedingDisplayRoundMessageId],
  );

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
    if (loadingRef.current) return;
    // Cap-hidden groups are already loaded — reveal one step locally (with
    // the same scroll preservation as a backend prepend) and only hit the
    // backend once the cap no longer hides anything. `exhausted` gates the
    // backend, not this purely local reveal.
    if (renderCap !== null && groups.length > renderCap) {
      const el = scrollContainerRef.current;
      if (el) prevScrollHeightRef.current = el.scrollHeight;
      loadingEarlierRef.current = true;
      setRenderCap(renderCap + RENDER_CAP);
      return;
    }
    if (!onLoadEarlier || exhaustedRef.current) return;
    const earliestId = sessionData.message_rows[0]?.id;
    // A summarize boundary can leave zero visible rows. In that case there is
    // no `before_id`; the backend anchors at maxMessageId + 1 when the user
    // explicitly asks to cross into archived history.
    if (!earliestId && !revealArchivedRef.current) return;
    loadingRef.current = true;
    const el = scrollContainerRef.current;
    if (el) prevScrollHeightRef.current = el.scrollHeight;
    loadingEarlierRef.current = true;
    setLoadingMore(true);
    try {
      // Rows→groups is at most 1:1, so growing the cap by the page size
      // guarantees the freshly fetched page is not immediately re-hidden.
      if (renderCap !== null) setRenderCap(renderCap + LOAD_MORE_SIZE);
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
  }, [groups.length, onLoadEarlier, renderCap, sessionData.message_rows, scrollContainerRef]);

  // Cross the "summarize & clear" boundary on explicit user request, then let
  // the normal infinite-scroll continue pulling archived pages.
  const handleRevealArchived = useCallback(() => {
    revealArchivedRef.current = true;
    setRevealArchived(true);
    void handleLoadEarlier();
  }, [handleLoadEarlier]);

  // After new messages are prepended — a backend page (messages.length) OR a
  // local cap reveal (cappedGroups.length) — restore scroll position.
  useLayoutEffect(() => {
    if (!loadingEarlierRef.current) return;
    loadingEarlierRef.current = false;
    const el = scrollContainerRef.current;
    if (!el) return;
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) el.scrollTop += delta;
  }, [sessionData.messages.length, cappedGroups.length, scrollContainerRef]);

  // Stable ref to the latest handleLoadEarlier — avoids re-creating the
  // IntersectionObserver every time the callback identity changes.
  const handleRef = useRef(handleLoadEarlier);
  handleRef.current = handleLoadEarlier;

  // Infinite scroll: auto-load when a sentinel element near the top becomes
  // visible. Active while the backend has more rows OR the render cap hides
  // already-loaded groups; uses refs for all guards to avoid stale closures
  // (handleLoadEarlier itself routes between cap reveal and backend fetch).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    const backendHasMore = hasEarlier && !!onLoadEarlier && !exhaustedRef.current;
    if (!sentinel || !root || (!backendHasMore && !capHidesGroups)) return;
    const requestEarlier = () => {
      if (!loadingRef.current) void handleRef.current();
    };
    const onScroll = () => {
      if (shouldLoadEarlierAtScrollTop(root.scrollTop)) requestEarlier();
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) requestEarlier();
      },
      { root, rootMargin: `${LOAD_EARLIER_SCROLL_THRESHOLD}px 0px 0px 0px` },
    );
    io.observe(sentinel);
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      root.removeEventListener('scroll', onScroll);
    };
  }, [capHidesGroups, hasEarlier, exhausted, onLoadEarlier, scrollContainerRef]);

  const providerId = sessionData.session.provider;
  // "Load earlier" affordance covers both sources of hidden history: backend
  // rows not yet fetched and loaded groups clipped by the render cap.
  const showEarlierControls = (hasEarlier && !exhausted) || capHidesGroups;

  return (
    <>
      {/* Sentinel for infinite scroll — triggers auto-load when near top */}
      {showEarlierControls && <div ref={sentinelRef} className="h-px" />}
      {showEarlierControls && (
        <div className="flex items-center justify-center gap-2 w-full py-2">
          <button
            type="button"
            onClick={handleLoadEarlier}
            disabled={loadingMore}
            className="flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-colors disabled:opacity-50"
          >
            <ChevronUp className="h-3.5 w-3.5" />
            {loadingMore ? t('messages.loading') : t('messages.loadEarlier')}
          </button>
          <span className="text-[10px] text-muted-foreground/60">
            {t('messages.loadedCount', { loaded: loadedCount, total: displayTotal })}
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
              ? t('messages.loading')
              : t('messages.showEarlierHistory', { count: archivedCount })}
          </button>
        </div>
      )}
      {exhausted && loadedCount < fullTotal && (
        <div className="text-center py-1.5 text-[10px] text-muted-foreground/50">
          {t('messages.allAvailableLoaded')}
        </div>
      )}
      {displayGroups.map((g, gi) => {
        const groupKey = g.kind === 'user'
          ? `u-${g.messageId ?? gi}`
          : `a-${g.messageIds[0] ?? gi}`;

        let el: React.ReactNode;
        if (g.kind === 'user') {
          el = (
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
        } else if (g.hasText && g.messages.length === 1) {
          // Single text-bearing assistant message → original MessageView (backward compat)
          el = (
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
        } else {
          // Grouped assistant bubble (multiple tool-only turns or single tool-only turn)
          el = (
            <GroupedToolBubble
              key={groupKey}
              group={g}
              toolResultsById={resultsById}
              sessionId={sessionData.session.id}
              providerId={providerId}
              handlers={handlers}
              tasksState={tasksState}
              activeTasksToolUseId={activeTasksToolUseId}
            />
          );
        }

        // Inject the per-turn "files changed" summary after the turn's final
        // assistant group. For the very last group, only once the turn has
        // ended (not streaming) — the in-flight turn gets a live summary below.
        const dividers = chapterMarkers.get(gi) ?? [];
        const summary = turnSummaries.get(gi);
        const showSummary = !!summary && (gi < displayGroups.length - 1 || !streaming);
        return (
          <React.Fragment key={`grp-${groupKey}`}>
            {dividers.map((chapter) => (
              <ConversationChapterDivider
                key={chapter.id}
                chapter={chapter}
                active={activeChapterId === chapter.id}
                onActivate={setActiveChapterId}
              />
            ))}
            {el}
            {showSummary && (
              <TurnFilesSummary
                paths={summary!.paths}
                roundMessageId={summary!.roundMessageId}
              />
            )}
          </React.Fragment>
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
  persistedToolUseIds,
  persistedInteractivePromptSignatures,
  continuation,
}: {
  currentTurn: AssistantTurn | null;
  streaming: boolean;
  preflight: { startedAt: number } | null;
  providerId: string;
  handlers: PromptHandlers;
  hidden: boolean;
  persistedToolUseIds: Set<string>;
  persistedInteractivePromptSignatures: Set<string>;
  continuation: boolean;
}) {
  // Drop live blocks already rendered by the persisted history (gate cards on a
  // paused turn, or a tool call the refetch landed before currentTurn cleared).
  const allBlocks = currentTurn?.blocks ?? [];
  const visible = visibleLiveBlocks(allBlocks, persistedToolUseIds, persistedInteractivePromptSignatures);
  const hasBlocks = visible.length > 0 && !hidden;
  if (hasBlocks) {
    return (
      <AssistantBubble providerId={providerId} streaming={streaming} continuation={continuation}>
        {visible.map((b, i) => renderStreamBlock(b, i, handlers))}
      </AssistantBubble>
    );
  }
  // Had blocks but every one was deduped into history → render nothing. The
  // persisted cards are showing above; a dot-pulse spinner here would be noise.
  if (allBlocks.length > 0 && !hidden) return null;
  // Blocking preflight on a fresh first message — labelled indicator instead of
  // the bare spinner, until the first SSE event clears it.
  if (preflight && !hidden) {
    return (
      <AssistantBubble providerId={providerId} streaming continuation={continuation}>
        <PreflightBlock startedAt={preflight.startedAt} />
      </AssistantBubble>
    );
  }
  if (streaming) {
    return (
      <AssistantBubble providerId={providerId} streaming continuation={continuation}>
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
  persistedToolUseIds,
  fallbackProviderId,
  tasksState,
  handlers,
  onLoadEarlier,
  snapshotActions = null,
  snapshotFiles,
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
  const persistedInteractivePromptSignatures = useMemo(
    () => collectLatestPersistedInteractivePromptSignatures(sessionData?.messages ?? []),
    [sessionData],
  );
  const liveContinuation = useMemo(
    () => liveTurnContinuesPersistedAssistant(sessionData?.messages ?? []),
    [sessionData],
  );
  const liveAgentIdentityKey = useMemo(() => JSON.stringify(
    (currentTurn?.blocks ?? []).flatMap((block) => (
      block.type === 'agents' && !block.group.groupId.startsWith('tasks-wave-')
        ? [{ toolUseId: block.group.toolUseId, groupId: block.group.groupId }]
        : []
    )),
  ), [currentTurn]);

  // Files edited by the live turn, for its completion summary. Shown only once
  // the turn ended AND before it's mirrored into persisted history (the same
  // dedup gate LiveTurn uses), so the summary never renders twice.
  const liveEditRefs = useMemo<EditFileRef[]>(() => {
    if (!currentTurn) return [];
    const byPath = new Map<string, EditFileRef>();
    for (const b of currentTurn.blocks) {
      if (b.type !== 'tool') continue;
      for (const ref of filesFromEditToolCall(b.call.name, b.call.input)) byPath.set(ref.path, ref);
    }
    return [...byPath.values()];
  }, [currentTurn]);
  const showLiveSummary = !streaming && !!doneReason && !liveTurnDuplicatedInHistory && liveEditRefs.length > 0;
  const liveRoundMessageId = useMemo(() => {
    if (!sessionData) return undefined;
    for (let index = sessionData.messages.length - 1; index >= 0; index--) {
      const message = sessionData.messages[index];
      if (message.role === 'user' && !message.isMeta) {
        return sessionData.message_rows[index]?.id;
      }
    }
    return sessionData.preceding_user_message_id ?? undefined;
  }, [sessionData]);
  const handleChapterNavigate = useCallback(() => {
    // A chapter jump is an explicit request to leave the live tail. Prevent
    // the normal sessionData-change effect from immediately snapping back to
    // the bottom when archived messages are prepended.
    stickToBottomRef.current = false;
  }, []);

  return (
    <div
      ref={scrollRef}
      data-text-selectable
      className="flex-1 overflow-y-auto overscroll-contain px-0 py-2 space-y-2 min-h-0"
    >
      <SnapshotFilesProvider actions={snapshotActions} files={snapshotFiles ?? EMPTY_FILES}>
        {sessionData && (
          <PersistedMessages
            sessionData={sessionData}
            handlers={handlers}
            tasksState={tasksState}
            scrollContainerRef={scrollRef}
            streaming={streaming}
            onLoadEarlier={onLoadEarlier}
            onChapterNavigate={handleChapterNavigate}
            liveAgentIdentityKey={liveAgentIdentityKey}
          />
        )}

        <LiveTurn
          currentTurn={currentTurn}
          streaming={streaming}
          preflight={preflight}
          providerId={providerId}
          handlers={handlers}
          hidden={liveTurnDuplicatedInHistory}
          persistedToolUseIds={persistedToolUseIds}
          persistedInteractivePromptSignatures={persistedInteractivePromptSignatures}
          continuation={liveContinuation}
        />

        {showLiveSummary && (
          <TurnFilesSummary paths={liveEditRefs} roundMessageId={liveRoundMessageId} />
        )}

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
      </SnapshotFilesProvider>
    </div>
  );
}
