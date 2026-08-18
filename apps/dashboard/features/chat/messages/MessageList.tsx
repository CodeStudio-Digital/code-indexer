import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowDown, ChevronUp, History, Loader2, RotateCw } from 'lucide-react';
import type { AssistantTurn } from '../../../hooks/useAgentStream.js';
import { Alert, AlertDescription } from '../../../components/ui/alert.js';
import { LOAD_MORE_SIZE } from '../constants.js';
import type {
  ConversationChapter,
  ConversationChapterSourceMessage,
  ConversationChapterSourcePage,
  EarlierMessagePageResult,
  MessageRow,
  PersistedMessage,
  PersistedTasksState,
  PromptHandlers,
  SessionData,
  ToolResultView,
  VisualGroup,
} from '../types.js';
import {
  groupMessages,
  mergeConsecutiveAssistantGroups,
} from '../utils.js';
import {
  projectTranscriptHistory,
  type TranscriptProjection,
} from '../transcript-projection.js';
import { AssistantBubble } from './AssistantBubble.js';
import { GroupedToolBubble } from './GroupedToolBubble.js';
import { MessageView } from './MessageView.js';
import { renderStreamBlock } from './renderStreamBlock.js';
import { PreflightBlock } from './PreflightBlock.js';
import { SnapshotFilesProvider, type SnapshotActions } from './snapshot-files-context.js';
import { TurnFilesSummary } from './TurnFilesSummary.js';
import { computeTurnEditSummaries } from './turn-summaries.js';
import type { TurnEditSummary } from './turn-summaries.js';
import { filesFromEditToolCall, type EditFileRef } from './edit-tools.js';
import type { SnapshotFileSummary } from '../../snapshots/types.js';
import {
  ConversationChapterDivider,
  useConversationChapters,
} from './ConversationChapters.js';
import {
  buildChapterTranscript,
  sortChaptersChronologically,
  visualGroupKey,
} from './chapter-transcript.js';
import { activeChapterIdAtScrollOffset } from './chapter-markers.js';
import { useFollowOutput } from './useFollowOutput.js';

const EMPTY_FILES: Map<string, SnapshotFileSummary> = new Map();
const LOAD_EARLIER_SCROLL_THRESHOLD = 200;
const CHAPTER_SOURCE_PAGE_SIZE = 100;
const MAX_DUPLICATE_PAGE_HOPS = 8;

/** Negative values cover elastic overscroll on touch devices. */
export function shouldLoadEarlierAtScrollTop(scrollTop: number): boolean {
  return scrollTop <= LOAD_EARLIER_SCROLL_THRESHOLD;
}

/**
 * `total_messages` follows the client-visible transcript and is incremented
 * when an optimistic user row is appended. Count that row here as loaded too,
 * otherwise a brand-new session briefly looks like an exhausted 0/1 history.
 */
export function loadedMessageCount(sessionData: SessionData | null): number {
  return sessionData?.message_rows.length ?? 0;
}

export interface MessageListProps {
  sessionData: SessionData | null;
  currentTurn: AssistantTurn | null;
  streaming: boolean;
  preflight?: { startedAt: number } | null;
  doneReason: string | null;
  error: string | null;
  projection: TranscriptProjection;
  tasksState: PersistedTasksState | null;
  handlers: PromptHandlers;
  onLoadEarlier?: (
    beforeSeq: number | undefined,
    limit?: number,
    includeArchived?: boolean,
  ) => Promise<EarlierMessagePageResult>;
  snapshotActions?: SnapshotActions | null;
  snapshotFiles?: Map<string, SnapshotFileSummary>;
}

interface ChapterSourceState {
  expanded: boolean;
  loading: boolean;
  error: boolean;
  items: ConversationChapterSourceMessage[];
}

interface PaginationState {
  sessionId: string | null;
  nextBeforeSeq: number | null;
  hasMore: boolean;
  includeArchived: boolean;
  status: 'idle' | 'loading' | 'error' | 'exhausted';
  error?: string;
}

type TurnSummary = TurnEditSummary;

type TranscriptRow =
  | { kind: 'history-control'; key: string }
  | { kind: 'chapter'; key: string; chapter: ConversationChapter }
  | {
      kind: 'message';
      key: string;
      group: VisualGroup;
      resultsById: ReadonlyMap<string, ToolResultView>;
      summary?: TurnSummary;
      sourceChapterId?: string;
    }
  | { kind: 'tail'; key: string };

function earliestPersistedSeq(sessionData: SessionData | null): number | null {
  if (!sessionData) return null;
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of sessionData.message_rows) {
    if (row.optimistic || row.seq <= 0) continue;
    earliest = Math.min(earliest, row.seq);
  }
  return Number.isFinite(earliest) ? earliest : null;
}

function parseSourceContent(item: ConversationChapterSourceMessage): PersistedMessage['content'] {
  if (Array.isArray(item.content)) return item.content;
  const raw = item.content_json ?? item.content;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as PersistedMessage['content'];
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { blocks?: unknown }).blocks)) {
      return (parsed as { blocks: PersistedMessage['content'] }).blocks;
    }
  } catch {
    if (typeof item.content === 'string') return [{ type: 'text', text: item.content }];
  }
  return [];
}

function parseSelectedSkills(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function projectChapterSource(items: readonly ConversationChapterSourceMessage[]): {
  groups: VisualGroup[];
  resultsById: Map<string, ToolResultView>;
  summaries: Map<number, TurnSummary>;
} {
  const messages: PersistedMessage[] = items.map((item) => {
    const selectedSkillIds = parseSelectedSkills(item.selected_skill_ids_json);
    return {
      role: item.role,
      content: parseSourceContent(item),
      ...(item.is_meta ? { isMeta: true } : {}),
      ...(selectedSkillIds?.length ? { selectedSkillIds } : {}),
    } as PersistedMessage;
  });
  const rows: MessageRow[] = items.map((item) => ({
    id: item.id,
    seq: item.seq,
    input_tokens: item.input_tokens ?? 0,
    output_tokens: item.output_tokens ?? 0,
    cache_read_tokens: item.cache_read_tokens ?? 0,
    cache_creation_tokens: item.cache_creation_tokens ?? 0,
  }));
  const resultsById = new Map<string, ToolResultView>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      resultsById.set(block.tool_use_id, {
        content: block.content ?? '',
        isError: Boolean(block.is_error),
        truncated: Boolean(block._truncated),
        originalLength: block._originalLength,
      });
    }
  }
  const groups = mergeConsecutiveAssistantGroups(groupMessages(messages, rows));
  return {
    groups,
    resultsById,
    summaries: computeTurnEditSummaries(groups),
  };
}

const TranscriptMessage = React.memo(function TranscriptMessage({
  group,
  resultsById,
  sessionId,
  handlers,
  tasksState,
  activeTasksToolUseId,
  summary,
}: {
  group: VisualGroup;
  resultsById: ReadonlyMap<string, ToolResultView>;
  sessionId: string;
  handlers: PromptHandlers;
  tasksState: PersistedTasksState | null;
  activeTasksToolUseId: string | null;
  summary?: TurnSummary;
}) {
  let content: React.ReactNode;
  if (group.kind === 'user') {
    content = (
      <MessageView
        message={group.message}
        messageId={group.messageId}
        sessionId={sessionId}
        toolResultsById={resultsById}
        usage={group.usage}
        onAnswer={handlers.onAnswer}
        onPlanResponse={handlers.onPlanResponse}
        onTasksResponse={handlers.onTasksResponse}
        onDecide={handlers.onDecide}
        onSpecResponse={handlers.onSpecResponse}
        onFork={handlers.onFork}
        onRollback={handlers.onRollback}
        rollbackPendingSeq={handlers.rollbackPendingSeq}
        tasksState={tasksState}
      />
    );
  } else if (group.hasText && group.messages.length === 1) {
    content = (
      <MessageView
        message={group.messages[0]}
        messageId={group.messageIds[0]}
        sessionId={sessionId}
        toolResultsById={resultsById}
        usage={group.usages[0]}
        onAnswer={handlers.onAnswer}
        onPlanResponse={handlers.onPlanResponse}
        onTasksResponse={handlers.onTasksResponse}
        onDecide={handlers.onDecide}
        onSpecResponse={handlers.onSpecResponse}
        onFork={handlers.onFork}
        onRollback={handlers.onRollback}
        rollbackPendingSeq={handlers.rollbackPendingSeq}
        tasksState={tasksState}
        activeTasksToolUseId={activeTasksToolUseId}
      />
    );
  } else {
    content = (
      <GroupedToolBubble
        group={group}
        toolResultsById={resultsById}
        sessionId={sessionId}
        handlers={handlers}
        tasksState={tasksState}
        activeTasksToolUseId={activeTasksToolUseId}
      />
    );
  }

  return (
    <>
      {content}
      {summary && (
        <TurnFilesSummary paths={summary.paths} roundMessageId={summary.roundMessageId} />
      )}
    </>
  );
});

const LiveTurn = React.memo(function LiveTurn({
  currentTurn,
  blocks,
  streaming,
  preflight,
  handlers,
  continuation,
}: {
  currentTurn: AssistantTurn | null;
  blocks: TranscriptProjection['live']['blocks'];
  streaming: boolean;
  preflight: { startedAt: number } | null;
  handlers: PromptHandlers;
  continuation: boolean;
}) {
  const allBlocks = currentTurn?.blocks ?? [];
  if (blocks.length > 0) {
    return (
      <AssistantBubble streaming={streaming} continuation={continuation}>
        {blocks.map((block, index) => renderStreamBlock(block, index, handlers))}
      </AssistantBubble>
    );
  }
  if (allBlocks.length > 0) return null;
  if (preflight) {
    return (
      <AssistantBubble streaming continuation={continuation}>
        <PreflightBlock startedAt={preflight.startedAt} />
      </AssistantBubble>
    );
  }
  if (streaming) {
    return (
      <AssistantBubble streaming continuation={continuation}>
        <div className="dot-pulse text-muted-foreground"><span /><span /><span /></div>
      </AssistantBubble>
    );
  }
  return null;
});

export const MessageList = React.memo(function MessageList({
  sessionData,
  currentTurn,
  streaming,
  preflight = null,
  doneReason,
  error,
  projection,
  tasksState,
  handlers,
  onLoadEarlier,
  snapshotActions = null,
  snapshotFiles,
}: MessageListProps) {
  const { t } = useTranslation('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionId = sessionData?.session.id ?? null;
  const chapterIndex = useConversationChapters(sessionId ?? '', '', {
    pageSize: 50,
    loadAll: true,
    detail: 'preview',
  });
  const chapters = useMemo(
    () => sortChaptersChronologically(chapterIndex.chapters),
    [chapterIndex.chapters],
  );
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const activeChapterRef = useRef<string | null>(null);
  activeChapterRef.current = activeChapterId;
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set());
  const [chapterDetails, setChapterDetails] = useState<Record<string, ConversationChapter>>({});
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());
  const [chapterSources, setChapterSources] = useState<Record<string, ChapterSourceState>>({});
  const sourceControllersRef = useRef<Map<string, AbortController>>(new Map());
  const detailControllersRef = useRef<Map<string, AbortController>>(new Map());

  const totalMessages = sessionData?.total_messages ?? sessionData?.message_rows.length ?? 0;
  const archivedCount = sessionData?.archived_count ?? 0;
  const fullTotal = totalMessages + archivedCount;
  const loadedCount = loadedMessageCount(sessionData);
  const initialCursor = earliestPersistedSeq(sessionData);
  const initialHasMore = totalMessages > loadedCount;
  const [pagination, setPagination] = useState<PaginationState>(() => ({
    sessionId,
    nextBeforeSeq: initialCursor,
    hasMore: initialHasMore,
    includeArchived: false,
    status: initialHasMore ? 'idle' : 'exhausted',
  }));
  const paginationRef = useRef(pagination);
  paginationRef.current = pagination;
  const previousWindowRef = useRef<{ sessionId: string | null; earliest: number | null; loaded: number }>({
    sessionId,
    earliest: initialCursor,
    loaded: loadedCount,
  });

  const commitPagination = useCallback((next: PaginationState) => {
    paginationRef.current = next;
    setPagination(next);
  }, []);

  useEffect(() => {
    const previous = previousWindowRef.current;
    const replacedWindow = previous.sessionId === sessionId
      && previous.earliest != null
      && initialCursor != null
      && initialCursor > previous.earliest
      && loadedCount <= previous.loaded;
    previousWindowRef.current = { sessionId, earliest: initialCursor, loaded: loadedCount };
    if (paginationRef.current.sessionId === sessionId && !replacedWindow) return;
    commitPagination({
      sessionId,
      nextBeforeSeq: initialCursor,
      hasMore: initialHasMore,
      includeArchived: false,
      status: initialHasMore ? 'idle' : 'exhausted',
    });
    setActiveChapterId(null);
    setExpandedSummaries(new Set());
    setChapterDetails({});
    setDetailLoading(new Set());
    setChapterSources({});
    for (const controller of sourceControllersRef.current.values()) controller.abort();
    for (const controller of detailControllersRef.current.values()) controller.abort();
    sourceControllersRef.current.clear();
    detailControllersRef.current.clear();
  }, [commitPagination, initialCursor, initialHasMore, loadedCount, sessionId]);

  useEffect(() => () => {
    for (const controller of sourceControllersRef.current.values()) controller.abort();
    for (const controller of detailControllersRef.current.values()) controller.abort();
  }, []);

  const loadEarlier = useCallback(async () => {
    const current = paginationRef.current;
    if (!onLoadEarlier || !current.sessionId || !current.hasMore || current.status === 'loading') return;
    commitPagination({ ...current, status: 'loading', error: undefined });
    let cursor = current.nextBeforeSeq ?? undefined;
    let final: EarlierMessagePageResult | null = null;
    const seenCursors = new Set<number | undefined>();
    for (let attempt = 0; attempt < MAX_DUPLICATE_PAGE_HOPS; attempt++) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      final = await onLoadEarlier(cursor, LOAD_MORE_SIZE, current.includeArchived);
      if (!final.ok || final.addedRows > 0 || !final.hasMore) break;
      cursor = final.nextBeforeSeq ?? undefined;
    }
    if (!final || !final.ok) {
      if (final?.reason === 'aborted' || final?.reason === 'stale') return;
      commitPagination({
        ...paginationRef.current,
        status: 'error',
        error: final?.error,
      });
      return;
    }
    if (final.addedRows === 0 && final.hasMore) {
      commitPagination({
        ...paginationRef.current,
        status: 'error',
        error: 'history cursor did not advance to an unseen page',
      });
      return;
    }
    commitPagination({
      ...paginationRef.current,
      nextBeforeSeq: final.nextBeforeSeq,
      hasMore: final.hasMore,
      status: final.hasMore ? 'idle' : 'exhausted',
      error: undefined,
    });
  }, [commitPagination, onLoadEarlier]);

  const canRevealLegacyArchive = !chapterIndex.loading
    && !chapterIndex.error
    && chapters.length === 0
    && !pagination.includeArchived
    && !pagination.hasMore
    && archivedCount > 0;
  const revealLegacyArchive = useCallback(() => {
    const current = paginationRef.current;
    const next = {
      ...current,
      includeArchived: true,
      hasMore: true,
      status: 'idle' as const,
      nextBeforeSeq: earliestPersistedSeq(sessionData),
    };
    commitPagination(next);
    queueMicrotask(() => void loadEarlier());
  }, [commitPagination, loadEarlier, sessionData]);

  const fetchChapterDetail = useCallback((chapter: ConversationChapter) => {
    if (!sessionId || chapterDetails[chapter.id] || detailControllersRef.current.has(chapter.id)) return;
    const controller = new AbortController();
    detailControllersRef.current.set(chapter.id, controller);
    setDetailLoading((current) => new Set(current).add(chapter.id));
    void fetch(`/api/coder/sessions/${sessionId}/chapters/${chapter.id}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ConversationChapter>;
      })
      .then((detail) => setChapterDetails((current) => ({ ...current, [chapter.id]: detail })))
      .catch(() => {})
      .finally(() => {
        detailControllersRef.current.delete(chapter.id);
        setDetailLoading((current) => {
          const next = new Set(current);
          next.delete(chapter.id);
          return next;
        });
      });
  }, [chapterDetails, sessionId]);

  const toggleChapter = useCallback((chapter: ConversationChapter) => {
    setActiveChapterId(chapter.id);
    setExpandedSummaries((current) => {
      const next = new Set(current);
      if (next.has(chapter.id)) next.delete(chapter.id);
      else {
        next.add(chapter.id);
        fetchChapterDetail(chapter);
      }
      return next;
    });
  }, [fetchChapterDetail]);

  const loadChapterSource = useCallback(async (chapter: ConversationChapter) => {
    if (!sessionId) return;
    const existing = chapterSources[chapter.id];
    if (existing?.loading) return;
    if (existing?.items.length) {
      setChapterSources((current) => ({
        ...current,
        [chapter.id]: { ...current[chapter.id], expanded: !current[chapter.id].expanded },
      }));
      return;
    }
    const controller = new AbortController();
    sourceControllersRef.current.get(chapter.id)?.abort();
    sourceControllersRef.current.set(chapter.id, controller);
    setChapterSources((current) => ({
      ...current,
      [chapter.id]: { expanded: true, loading: true, error: false, items: [] },
    }));
    try {
      const collected: ConversationChapterSourceMessage[] = [];
      const seenRows = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        if (cursor && seenCursors.has(cursor)) throw new Error('chapter cursor did not advance');
        if (cursor) seenCursors.add(cursor);
        const query = new URLSearchParams({ limit: String(CHAPTER_SOURCE_PAGE_SIZE) });
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(
          `/api/coder/sessions/${sessionId}/chapters/${chapter.id}/messages?${query}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = await response.json() as ConversationChapterSourcePage;
        for (const item of page.items) {
          if (seenRows.has(item.id)) continue;
          seenRows.add(item.id);
          collected.push(item);
        }
        cursor = page.next_cursor ?? null;
      } while (cursor);
      collected.sort((left, right) => left.seq - right.seq);
      setChapterSources((current) => ({
        ...current,
        [chapter.id]: { expanded: true, loading: false, error: false, items: collected },
      }));
    } catch (sourceError) {
      if ((sourceError as { name?: string })?.name === 'AbortError') return;
      setChapterSources((current) => ({
        ...current,
        [chapter.id]: {
          expanded: true,
          loading: false,
          error: true,
          items: current[chapter.id]?.items ?? [],
        },
      }));
    } finally {
      sourceControllersRef.current.delete(chapter.id);
    }
  }, [chapterSources, sessionId]);

  const displayGroups = useMemo(() => sessionData
    ? projectTranscriptHistory(
        projection.historyGroups,
        projection,
        sessionData.preceding_user_seq,
      )
    : [], [projection, sessionData]);
  const turnSummaries = useMemo(
    () => computeTurnEditSummaries(displayGroups, sessionData?.preceding_user_seq),
    [displayGroups, sessionData?.preceding_user_seq],
  );
  const sourceProjections = useMemo(() => {
    const projected = new Map<string, ReturnType<typeof projectChapterSource>>();
    for (const [chapterId, source] of Object.entries(chapterSources)) {
      if (source.items.length > 0) projected.set(chapterId, projectChapterSource(source.items));
    }
    return projected;
  }, [chapterSources]);

  const historyItems = useMemo(
    () => buildChapterTranscript(chapters, displayGroups),
    [chapters, displayGroups],
  );
  const displayGroupIndexes = useMemo(
    () => new Map(displayGroups.map((group, index) => [group, index])),
    [displayGroups],
  );
  const rows = useMemo<TranscriptRow[]>(() => {
    const result: TranscriptRow[] = [];
    const showHistoryControl = pagination.hasMore
      || pagination.status === 'loading'
      || pagination.status === 'error'
      || chapterIndex.error
      || canRevealLegacyArchive
      || (pagination.status === 'exhausted'
        && loadedCount < (pagination.includeArchived ? fullTotal : totalMessages)
        && chapters.length === 0);
    if (showHistoryControl) result.push({ kind: 'history-control', key: 'history-control' });
    for (const item of historyItems) {
      if (item.kind === 'message') {
        const groupIndex = displayGroupIndexes.get(item.group) ?? -1;
        result.push({
          kind: 'message',
          key: item.key,
          group: item.group,
          resultsById: projection.toolResultsById,
          summary: turnSummaries.get(groupIndex),
        });
        continue;
      }
      const chapter = item.chapter;
      result.push({ kind: 'chapter', key: item.key, chapter });
      const source = chapterSources[chapter.id];
      const sourceProjection = sourceProjections.get(chapter.id);
      if (!source?.expanded || !sourceProjection) continue;
      sourceProjection.groups.forEach((group, index) => result.push({
        kind: 'message',
        key: `chapter-source:${chapter.id}:${visualGroupKey(group)}`,
        group,
        resultsById: sourceProjection.resultsById,
        summary: sourceProjection.summaries.get(index),
        sourceChapterId: chapter.id,
      }));
    }
    result.push({ kind: 'tail', key: `tail:${sessionId ?? 'empty'}` });
    return result;
  }, [
    canRevealLegacyArchive,
    chapterIndex.error,
    chapterSources,
    chapters.length,
    displayGroups,
    displayGroupIndexes,
    fullTotal,
    historyItems,
    loadedCount,
    pagination.hasMore,
    pagination.includeArchived,
    pagination.status,
    projection.toolResultsById,
    sessionId,
    sourceProjections,
    totalMessages,
    turnSummaries,
  ]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rowsRef.current[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rowsRef.current[index];
      if (row?.kind === 'history-control') return 48;
      if (row?.kind === 'chapter') return expandedSummaries.has(row.chapter.id) ? 300 : 68;
      if (row?.kind === 'tail') return 160;
      return 180;
    },
    // `followOnAppend` is intentionally absent: its guard requires the last item
    // key to change, and the last row here is always the `tail:` sentinel, so it
    // could never fire. Sticking to the bottom is `useFollowOutput`'s job.
    anchorTo: 'end',
    scrollEndThreshold: 80,
    overscan: 6,
    useAnimationFrameWithResizeObserver: true,
    onChange: (instance) => {
      const visibleChapter = activeChapterIdAtScrollOffset(
        rowsRef.current,
        instance.getVirtualItems(),
        instance.scrollOffset ?? 0,
      );
      if (visibleChapter !== activeChapterRef.current) {
        activeChapterRef.current = visibleChapter;
        setActiveChapterId(visibleChapter);
      }
    },
  });

  // Declared after the virtualizer so its pin runs on the committed spacer height.
  const { following, jumpToEnd, disengage } = useFollowOutput({ scrollRef, resetKey: sessionId });

  const chapterRowIndexes = useMemo(() => {
    const indexes = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === 'chapter') indexes.set(row.chapter.id, index);
    });
    return indexes;
  }, [rows]);
  const scrollToChapter = useCallback((chapterId: string) => {
    const index = chapterRowIndexes.get(chapterId);
    if (index == null) return;
    setActiveChapterId(chapterId);
    // A pin racing this smooth scroll would drag the view back to the bottom.
    disengage();
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
  }, [chapterRowIndexes, disengage, virtualizer]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId: string;
        chapterId: string;
        expandConversation?: boolean;
      }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      const chapter = chapters.find((candidate) => candidate.id === detail.chapterId);
      if (!chapter) return;
      setExpandedSummaries((current) => new Set(current).add(chapter.id));
      fetchChapterDetail(chapter);
      if (detail.expandConversation && !chapterSources[chapter.id]?.expanded) {
        void loadChapterSource(chapter);
      }
      requestAnimationFrame(() => scrollToChapter(chapter.id));
    };
    window.addEventListener('coder:chapter-source', navigate);
    return () => window.removeEventListener('coder:chapter-source', navigate);
  }, [chapterSources, chapters, fetchChapterDetail, loadChapterSource, scrollToChapter, sessionId]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !onLoadEarlier) return;
    const onScroll = () => {
      if (shouldLoadEarlierAtScrollTop(root.scrollTop)) void loadEarlier();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [loadEarlier, onLoadEarlier]);

  const liveEditRefs = useMemo<EditFileRef[]>(() => {
    if (!currentTurn) return [];
    const byPath = new Map<string, EditFileRef>();
    for (const block of currentTurn.blocks) {
      if (block.type !== 'tool') continue;
      for (const ref of filesFromEditToolCall(block.call.name, block.call.input)) byPath.set(ref.path, ref);
    }
    return [...byPath.values()];
  }, [currentTurn]);
  const showLiveSummary = !streaming
    && !!doneReason
    && !projection.live.duplicated
    && liveEditRefs.length > 0;
  const liveRoundMessageId = useMemo(() => {
    if (!sessionData) return undefined;
    for (let index = sessionData.messages.length - 1; index >= 0; index--) {
      const message = sessionData.messages[index];
      if (message.role === 'user' && !(message as PersistedMessage & { isMeta?: boolean }).isMeta) {
        const row = sessionData.message_rows[index];
        return row?.optimistic ? undefined : row?.seq;
      }
    }
    return sessionData.preceding_user_seq ?? undefined;
  }, [sessionData]);

  const renderHistoryControl = () => {
    const expectedTotal = pagination.includeArchived ? fullTotal : totalMessages;
    const incomplete = pagination.status === 'exhausted' && loadedCount < expectedTotal;
    if (chapterIndex.error) {
      return (
        <div className="flex items-center justify-center gap-2 py-2 text-[10px] text-destructive">
          <span>{t('messages.chapterLoadError')}</span>
          <button type="button" onClick={chapterIndex.refresh} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-destructive/10">
            <RotateCw className="h-3 w-3" /> {t('messages.retry')}
          </button>
        </div>
      );
    }
    if (pagination.status === 'error' || incomplete) {
      return (
        <div className="flex items-center justify-center gap-2 py-2 text-[10px] text-destructive">
          <span>{t(incomplete ? 'messages.historyIncomplete' : 'messages.historyLoadError')}</span>
          <button type="button" onClick={() => void loadEarlier()} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-destructive/10">
            <RotateCw className="h-3 w-3" /> {t('messages.retry')}
          </button>
        </div>
      );
    }
    if (canRevealLegacyArchive) {
      return (
        <div className="flex items-center justify-center py-2">
          <button type="button" onClick={revealLegacyArchive} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
            <History className="h-3.5 w-3.5" />
            {t('messages.showEarlierHistory', { count: archivedCount })}
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center gap-2 py-2">
        <button
          type="button"
          onClick={() => void loadEarlier()}
          disabled={pagination.status === 'loading'}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          {pagination.status === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className="h-3.5 w-3.5" />}
          {pagination.status === 'loading' ? t('messages.loading') : t('messages.loadEarlier')}
        </button>
        <span className="text-[10px] text-muted-foreground/60">
          {t('messages.loadedCount', { loaded: loadedCount, total: expectedTotal })}
        </span>
      </div>
    );
  };

  return (
    <div className="relative min-h-0 flex-1">
      {chapters.length > 1 && (
        <nav
          aria-label={t('messages.chapterQuickNav')}
          className="absolute left-1 top-1/2 z-20 flex max-h-[60%] -translate-y-1/2 flex-col items-center gap-1 overflow-y-auto rounded-full border border-border/55 bg-background/80 px-1.5 py-2 shadow-lg backdrop-blur"
        >
          {chapters.map((chapter) => (
            <button
              key={chapter.id}
              type="button"
              title={`#${chapter.ordinal} · ${chapter.title}`}
              aria-label={`#${chapter.ordinal} · ${chapter.title}`}
              aria-current={activeChapterId === chapter.id ? 'location' : undefined}
              onClick={() => scrollToChapter(chapter.id)}
              className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${activeChapterId === chapter.id ? 'scale-150 bg-primary' : 'bg-muted-foreground/40 hover:bg-primary/75'}`}
            />
          ))}
        </nav>
      )}
      {!following && (
        <button
          type="button"
          onClick={jumpToEnd}
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/55 bg-background/80 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition-colors hover:bg-accent"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          {t('messages.jumpToLatest')}
          {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
        </button>
      )}
      <div
        ref={scrollRef}
        data-text-selectable
        className="chat-transcript h-full overflow-y-auto overscroll-contain"
      >
        <SnapshotFilesProvider actions={snapshotActions} files={snapshotFiles ?? EMPTY_FILES}>
          <div
            className="relative mx-auto w-full max-w-[860px]"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {chapters.length > 0 && (
              <span className="pointer-events-none absolute bottom-0 left-[22px] top-0 w-px bg-gradient-to-b from-primary/35 via-border/70 to-border/15 sm:left-[34px] lg:left-[42px]" />
            )}
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full px-3 pb-3 sm:px-6 lg:px-8"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === 'history-control' && renderHistoryControl()}
                  {row.kind === 'chapter' && (
                    <ConversationChapterDivider
                      chapter={row.chapter}
                      detail={chapterDetails[row.chapter.id]}
                      detailLoading={detailLoading.has(row.chapter.id)}
                      active={activeChapterId === row.chapter.id}
                      expanded={expandedSummaries.has(row.chapter.id)}
                      conversationExpanded={chapterSources[row.chapter.id]?.expanded ?? false}
                      conversationLoading={chapterSources[row.chapter.id]?.loading ?? false}
                      conversationError={chapterSources[row.chapter.id]?.error ?? false}
                      onActivate={setActiveChapterId}
                      onToggle={toggleChapter}
                      onToggleConversation={(chapter) => void loadChapterSource(chapter)}
                    />
                  )}
                  {row.kind === 'message' && (
                    <div className={row.sourceChapterId ? 'pl-10' : chapters.length > 0 ? 'pl-8' : ''}>
                      <TranscriptMessage
                        group={row.group}
                        resultsById={row.resultsById}
                        sessionId={sessionId ?? ''}
                        handlers={handlers}
                        tasksState={row.sourceChapterId ? null : tasksState}
                        activeTasksToolUseId={row.sourceChapterId ? null : projection.activeTasksToolUseId}
                        summary={row.summary}
                      />
                    </div>
                  )}
                  {row.kind === 'tail' && (
                    <div className={chapters.length > 0 ? 'space-y-3 pl-8 pt-1' : 'space-y-3 pt-1'}>
                      <LiveTurn
                        currentTurn={currentTurn}
                        blocks={projection.live.blocks}
                        streaming={streaming}
                        preflight={preflight}
                        handlers={handlers}
                        continuation={projection.live.continuation}
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
                        <span className="sr-only" data-run-finished={doneReason}>{doneReason}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SnapshotFilesProvider>
      </div>
    </div>
  );
});
