import type { ConversationChapter, ConversationChapterPage, ConversationChapterStatus } from '../types.js';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);

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
    requestRef.current?.abort();
    inFlightRef.current = false;
    if (!sessionId) {
      setChapters([]);
      setNextCursor(null);
      setLoading(false);
      setError(false);
      setStatus(null);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    inFlightRef.current = true;
    setChapters([]);
    setNextCursor(null);
    setLoading(true);
    setError(false);
    setStatus(null);
    void (async () => {
      const collected: ConversationChapter[] = [];
      const seen = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let latestStatus: ConversationChapterStatus | null = null;
      do {
        if (cursor && seenCursors.has(cursor)) throw new Error('chapter cursor did not advance');
        if (cursor) seenCursors.add(cursor);
        const page = await fetchPage(cursor, controller.signal);
        if (controller.signal.aborted) return;
        for (const chapter of Array.isArray(page.items) ? page.items : []) {
          if (seen.has(chapter.id)) continue;
          seen.add(chapter.id);
          collected.push(chapter);
        }
        latestStatus = page.status ?? latestStatus;
        cursor = page.next_cursor ?? undefined;
        // Publish the first lightweight markers immediately; later pages must
        // not delay usable navigation behind the complete chapter index.
        setChapters([...collected]);
        setNextCursor(cursor ?? null);
        setStatus(latestStatus);
      } while (loadAll && cursor && !controller.signal.aborted);
    })()
      .catch((err: unknown) => {
        if (!controller.signal.aborted && (err as { name?: string })?.name !== 'AbortError') setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          inFlightRef.current = false;
          setLoading(false);
        }
      });
    return () => { controller.abort(); requestRef.current?.abort(); };
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
    if (!nextCursor || loading || inFlightRef.current) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    inFlightRef.current = true;
    setLoading(true);
    setError(false);
    try {
      const page = await fetchPage(nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      if (page.next_cursor === nextCursor) throw new Error('chapter cursor did not advance');
      setChapters((current) => {
        const seen = new Set(current.map((chapter) => chapter.id));
        return [...current, ...page.items.filter((chapter) => !seen.has(chapter.id))];
      });
      setNextCursor(page.next_cursor ?? null);
      setStatus(page.status ?? null);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }, [fetchPage, loading, nextCursor]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { chapters, nextCursor, loading, error, status, loadMore, refresh };
}
