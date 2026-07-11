import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  ChevronDown,
  FileText,
  Loader2,
  MessageSquareText,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type {
  ContentBlock,
  ConversationChapter,
  ConversationChapterContent,
  ConversationChapterPage,
  ConversationChapterSourceMessage,
  ConversationChapterSourcePage,
  ConversationResumeContent,
} from '../types.js';

const CHAPTER_PAGE_SIZE = 10;
const SOURCE_PAGE_SIZE = 40;

interface ChapterIndexState {
  chapters: ConversationChapter[];
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  loadMore: () => Promise<void>;
  refresh: () => void;
}

function safeJson<T extends object>(value: string | T | null | undefined): T | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

function formatChapterDate(value: string, formatter: Intl.DateTimeFormat): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatter.format(date);
}

export function useConversationChapters(sessionId: number): ChapterIndexState {
  const [chapters, setChapters] = useState<ConversationChapter[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);

  const fetchPage = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(CHAPTER_PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    const response = await fetch(`/api/coder/sessions/${sessionId}/chapters?${qs}`, { signal });
    if (!response.ok) throw new Error(`chapters request failed (${response.status})`);
    return await response.json() as ConversationChapterPage;
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setChapters([]);
    setNextCursor(null);
    setLoading(true);
    setError(false);
    void fetchPage(undefined, controller.signal)
      .then((page) => {
        setChapters(Array.isArray(page.items) ? page.items : []);
        setNextCursor(page.next_cursor ?? null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fetchPage, revision]);

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
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, loading, nextCursor]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { chapters, nextCursor, loading, error, loadMore, refresh };
}

function contentBlocksText(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text ?? '';
    if (block.type === 'tool_use') return `[${block.name ?? 'tool'}]`;
    if (block.type === 'tool_result') return block.content ?? '';
    return `[${block.type}]`;
  }).filter(Boolean).join('\n');
}

function sourceMessageText(message: ConversationChapterSourceMessage): string {
  if (Array.isArray(message.content)) return contentBlocksText(message.content);
  if (typeof message.content === 'string') {
    const parsed = safeJson<{ blocks?: ContentBlock[] }>(message.content);
    if (parsed?.blocks && Array.isArray(parsed.blocks)) return contentBlocksText(parsed.blocks);
    const parsedArray = (() => {
      try { return JSON.parse(message.content as string) as unknown; } catch { return null; }
    })();
    if (Array.isArray(parsedArray)) return contentBlocksText(parsedArray as ContentBlock[]);
    return message.content;
  }
  if (message.content_json) {
    try {
      const parsed = JSON.parse(message.content_json) as unknown;
      if (Array.isArray(parsed)) return contentBlocksText(parsed as ContentBlock[]);
    } catch { /* malformed legacy row: show an empty preview */ }
  }
  return '';
}

function DetailSection({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <section className="space-y-1">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</h4>
      <ul className="space-y-1 text-xs text-foreground/80">
        {values.map((value, index) => <li key={`${index}-${value}`} className="break-words">• {value}</li>)}
      </ul>
    </section>
  );
}

interface SourceState {
  open: boolean;
  loading: boolean;
  items: ConversationChapterSourceMessage[];
  nextCursor: string | null;
  error: boolean;
}

const EMPTY_SOURCE: SourceState = {
  open: false,
  loading: false,
  items: [],
  nextCursor: null,
  error: false,
};

interface ConversationChaptersTimelineProps extends ChapterIndexState {
  sessionId: number;
  fallbackSummary?: string | null;
}

export function ConversationChaptersTimeline({
  sessionId,
  chapters,
  nextCursor,
  loading,
  error,
  loadMore,
  refresh,
  fallbackSummary,
}: ConversationChaptersTimelineProps) {
  const { t, i18n } = useTranslation('chat');
  const [openId, setOpenId] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, ConversationChapter>>({});
  const [detailLoading, setDetailLoading] = useState<Set<number>>(new Set());
  const [sources, setSources] = useState<Record<number, SourceState>>({});
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState(false);
  const hasLegacy = chapters.some((chapter) => chapter.source === 'legacy' && !chapter.superseded_at);

  const rebuildLegacy = useCallback(async () => {
    setRebuilding(true);
    setRebuildError(false);
    try {
      const response = await fetch(`/api/coder/sessions/${sessionId}/chapters/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived_only: true }),
      });
      if (!response.ok) throw new Error(String(response.status));
      refresh();
    } catch {
      setRebuildError(true);
    } finally {
      setRebuilding(false);
    }
  }, [refresh, sessionId]);

  const latestChapterId = chapters[0]?.id;
  useEffect(() => {
    setOpenId((current) => (
      current != null && chapters.some((chapter) => chapter.id === current)
        ? current
        : latestChapterId ?? null
    ));
  }, [chapters, latestChapterId]);

  useEffect(() => {
    if (!openId || details[openId]) return;
    const controller = new AbortController();
    setDetailLoading((current) => new Set(current).add(openId));
    void fetch(`/api/coder/sessions/${sessionId}/chapters/${openId}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<ConversationChapter>;
      })
      .then((chapter) => setDetails((current) => ({ ...current, [openId]: chapter })))
      .catch(() => {})
      .finally(() => setDetailLoading((current) => {
        const next = new Set(current);
        next.delete(openId);
        return next;
      }));
    return () => controller.abort();
  }, [details, openId, sessionId]);

  const loadSource = useCallback(async (chapterId: number, cursor?: string) => {
    setSources((current) => ({
      ...current,
      [chapterId]: { ...(current[chapterId] ?? EMPTY_SOURCE), open: true, loading: true, error: false },
    }));
    try {
      const qs = new URLSearchParams({ limit: String(SOURCE_PAGE_SIZE) });
      if (cursor) qs.set('cursor', cursor);
      const response = await fetch(`/api/coder/sessions/${sessionId}/chapters/${chapterId}/messages?${qs}`);
      if (!response.ok) throw new Error(String(response.status));
      const page = await response.json() as ConversationChapterSourcePage;
      setSources((current) => {
        const previous = current[chapterId] ?? EMPTY_SOURCE;
        const seen = new Set(previous.items.map((item) => item.id));
        return {
          ...current,
          [chapterId]: {
            open: true,
            loading: false,
            error: false,
            items: [...previous.items, ...page.items.filter((item) => !seen.has(item.id))],
            nextCursor: page.next_cursor ?? null,
          },
        };
      });
    } catch {
      setSources((current) => ({
        ...current,
        [chapterId]: { ...(current[chapterId] ?? EMPTY_SOURCE), open: true, loading: false, error: true },
      }));
    }
  }, [sessionId]);

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }), [i18n.language]);

  if (!loading && chapters.length === 0 && !fallbackSummary) return null;

  if (!loading && chapters.length === 0 && fallbackSummary) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
          <BookOpen className="h-3.5 w-3.5" />
          {t('messages.chaptersTitle')}
        </div>
        <div className="border-t border-border/50 px-3 py-3">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('messages.chapterLegacy')}
          </div>
          <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80">
            {fallbackSummary}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium text-muted-foreground">{t('messages.chaptersTitle')}</h3>
        {chapters.length > 0 && (
          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {chapters.length}
          </span>
        )}
        {hasLegacy && (
          <button
            type="button"
            disabled={rebuilding}
            onClick={() => void rebuildLegacy()}
            className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('messages.chapterRebuildHint')}
          >
            {rebuilding ? t('messages.chapterRebuilding') : t('messages.chapterRebuild')}
          </button>
        )}
      </header>

      {rebuildError && (
        <div className="border-b border-border/50 px-3 py-1.5 text-[10px] text-destructive">
          {t('messages.chapterRebuildError')}
        </div>
      )}

      <div className="relative px-2 py-1">
        <div className="absolute bottom-4 left-[19px] top-4 w-px bg-border/70" />
        {chapters.map((item) => {
          const chapter = details[item.id] ?? item;
          const open = openId === item.id;
          const parsed = safeJson<ConversationChapterContent>(chapter.chapter_json);
          const resume = safeJson<ConversationResumeContent>(chapter.resume_json);
          const source = sources[item.id] ?? EMPTY_SOURCE;
          const fileValues = parsed?.files?.map((file) => file.state ? `${file.path} — ${file.state}` : file.path);
          const formattedDate = chapter.created_at ? formatChapterDate(chapter.created_at, dateFormatter) : '';
          return (
            <article key={item.id} className="relative pl-6">
              <span className={cn(
                'absolute left-[7px] top-3.5 h-2 w-2 rounded-full border-2 border-background',
                open ? 'bg-primary' : 'bg-muted-foreground/50',
              )} />
              <button
                type="button"
                onClick={() => setOpenId(open ? null : item.id)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/50"
                aria-expanded={open}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground/90">
                    {chapter.title || parsed?.title || t('messages.chapterNumber', { ordinal: chapter.ordinal })}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                    <span>{t(`messages.chapterSource.${chapter.source}`, { defaultValue: chapter.source })}</span>
                    <span>#{chapter.start_message_id}–#{chapter.end_message_id}</span>
                    {formattedDate && <span>{formattedDate}</span>}
                  </div>
                </div>
                <ChevronDown className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
              </button>

              {open && (
                <div className="mx-2 mb-2 space-y-3 rounded-md border border-border/50 bg-background/40 p-3">
                  {detailLoading.has(item.id) && !details[item.id] ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('messages.chapterLoading')}
                    </div>
                  ) : (
                    <>
                      {(parsed?.summary || chapter.chapter_text) && (
                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80">
                          {parsed?.summary || chapter.chapter_text}
                        </p>
                      )}
                      <DetailSection label={t('messages.chapterUserRequests')} values={parsed?.user_requests} />
                      <DetailSection label={t('messages.chapterDecisions')} values={parsed?.decisions} />
                      <DetailSection label={t('messages.chapterWorkCompleted')} values={parsed?.work_completed} />
                      <DetailSection label={t('messages.chapterFiles')} values={fileValues} />
                      <DetailSection label={t('messages.chapterOpenIssues')} values={parsed?.open_issues} />
                      <DetailSection label={t('messages.chapterResolvedIssues')} values={parsed?.resolved_issues} />
                      {(resume?.current_focus || resume?.next_step) && (
                        <section className="rounded-md bg-muted/40 p-2 text-xs text-foreground/75">
                          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('messages.chapterResumeState')}
                          </h4>
                          {resume.current_focus && <p>{resume.current_focus}</p>}
                          {resume.next_step && <p className="mt-1"><strong>{t('messages.chapterNextStep')}:</strong> {resume.next_step}</p>}
                        </section>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (source.open) {
                        setSources((current) => ({ ...current, [item.id]: { ...source, open: false } }));
                      } else if (source.items.length > 0) {
                        setSources((current) => ({ ...current, [item.id]: { ...source, open: true } }));
                      } else {
                        void loadSource(item.id);
                      }
                    }}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    <MessageSquareText className="h-3.5 w-3.5" />
                    {source.open ? t('messages.chapterHideSource') : t('messages.chapterShowSource')}
                  </button>

                  {source.open && (
                    <div className="space-y-2 border-l border-border/70 pl-3">
                      {source.items.map((message) => (
                        <div key={message.id} className="text-xs">
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t(`messages.chapterRole.${message.role}`, { defaultValue: message.role })} · #{message.id}
                          </div>
                          <div className="max-h-32 overflow-hidden whitespace-pre-wrap break-words text-foreground/75">
                            {sourceMessageText(message) || t('messages.chapterEmptyMessage')}
                          </div>
                        </div>
                      ))}
                      {source.loading && (
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> {t('messages.chapterLoading')}
                        </div>
                      )}
                      {source.error && <div className="text-[10px] text-destructive">{t('messages.chapterLoadError')}</div>}
                      {source.nextCursor && !source.loading && (
                        <button
                          type="button"
                          onClick={() => void loadSource(item.id, source.nextCursor!)}
                          className="text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {t('messages.chapterLoadMoreSource')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {(nextCursor || loading || error) && (
        <footer className="flex items-center justify-center border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
          {loading ? (
            <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> {t('messages.chapterLoading')}</span>
          ) : nextCursor ? (
            <button type="button" onClick={() => void loadMore()} className="flex items-center gap-1 hover:text-foreground">
              <FileText className="h-3 w-3" /> {t('messages.chapterLoadOlder')}
            </button>
          ) : error ? t('messages.chapterLoadError') : null}
        </footer>
      )}
    </section>
  );
}

/** Divider rendered only when a chapter's original message range is loaded. */
export function ConversationChapterDivider({ chapter }: { chapter: ConversationChapter }) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] text-muted-foreground" data-chapter-id={chapter.id}>
      <span className="h-px flex-1 bg-border/70" />
      <BookOpen className="h-3 w-3" />
      <span className="max-w-[65%] truncate">
        {chapter.title || t('messages.chapterNumber', { ordinal: chapter.ordinal })}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}
