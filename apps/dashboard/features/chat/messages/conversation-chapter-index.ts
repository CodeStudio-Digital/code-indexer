import type { ConversationChapter, ConversationChapterPage, ConversationChapterStatus } from '../types.js';
import { useCallback, useEffect, useState } from 'react';

const CHAPTER_PAGE_SIZE = 10;

interface ChapterIndexOptions {
  pageSize?: number;
  /** Transcript timelines need every lightweight chapter marker in order. */
  loadAll?: boolean;
  detail?: 'full' | 'preview';
}

export interface ChapterIndexState {
  chapters: ConversationChapter[];
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  status: ConversationChapterStatus | null;
  loadMore: () => Promise<void>;
  refresh: () => void;
}

export function useConversationChapters(
  sessionId: string,
  query = '',
  options: ChapterIndexOptions = {},
): ChapterIndexState {
  const pageSize = options.pageSize ?? CHAPTER_PAGE_SIZE;
  const loadAll = options.loadAll ?? false;
  const detail = options.detail ?? 'full';
  const [chapters, setChapters] = useState<ConversationChapter[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<ConversationChapterStatus | null>(null);
  const [revision, setRevision] = useState(0);

  const fetchPage = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(pageSize) });
    if (detail === 'preview') qs.set('detail', 'preview');
    if (cursor) qs.set('cursor', cursor);
    if (query.trim()) qs.set('q', query.trim());
    const response = await fetch(`/api/coder/sessions/${sessionId}/chapters?${qs}`, { signal });
    if (!response.ok) throw new Error(`chapters request failed (${response.status})`);
    return await response.json() as ConversationChapterPage;
  }, [detail, pageSize, query, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setChapters([]);
      setNextCursor(null);
      setLoading(false);
      setError(false);
      setStatus(null);
      return;
    }
    const controller = new AbortController();
    setChapters([]);
    setNextCursor(null);
    setLoading(true);
    setError(false);
    setStatus(null);
    void (async () => {
      const collected: ConversationChapter[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let latestStatus: ConversationChapterStatus | null = null;
      do {
        const page = await fetchPage(cursor, controller.signal);
        for (const chapter of Array.isArray(page.items) ? page.items : []) {
          if (seen.has(chapter.id)) continue;
          seen.add(chapter.id);
          collected.push(chapter);
        }
        latestStatus = page.status ?? latestStatus;
        cursor = page.next_cursor ?? undefined;
      } while (loadAll && cursor && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      setChapters(collected);
      setNextCursor(cursor ?? null);
      setStatus(latestStatus);
    })()
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetchPage, loadAll, revision]);

  useEffect(() => {
    const handleChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      setRevision((value) => value + 1);
    };
    window.addEventListener('coder:chapters-changed', handleChanged);
    return () => window.removeEventListener('coder:chapters-changed', handleChanged);
  }, [sessionId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchPage(nextCursor);
      setChapters((current) => {
        const seen = new Set(current.map((chapter) => chapter.id));
        return [...current, ...page.items.filter((chapter) => !seen.has(chapter.id))];
      });
      setNextCursor(page.next_cursor ?? null);
      setStatus(page.status ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, loading, nextCursor]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { chapters, nextCursor, loading, error, status, loadMore, refresh };
}
