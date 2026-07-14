import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  FileText,
  Flag,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  WandSparkles,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { cn } from '../../../lib/utils.js';
import type {
  ContentBlock,
  ConversationChapter,
  ConversationChapterContent,
  ConversationChapterPage,
  ConversationChapterSourceMessage,
  ConversationChapterSourcePage,
  ConversationChapterStatus,
  ConversationResumeContent,
} from '../types.js';

const CHAPTER_PAGE_SIZE = 10;
const SOURCE_PAGE_SIZE = 40;

interface ChapterIndexState {
  chapters: ConversationChapter[];
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  status: ConversationChapterStatus | null;
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

export function resolvedChapterKind(
  chapter: ConversationChapter,
): NonNullable<ConversationChapter['chapter_kind']> {
  if (chapter.chapter_kind) return chapter.chapter_kind;
  if (chapter.source === 'rebuild' || chapter.source === 'legacy') return 'rebuild';
  return chapter.trigger?.startsWith('milestone:') ? 'milestone' : 'context';
}

export function chapterPreviewText(chapter: ConversationChapter): string {
  const parsed = safeJson<ConversationChapterContent>(chapter.chapter_json);
  const resume = safeJson<ConversationResumeContent>(chapter.resume_json);
  return [
    parsed?.summary,
    chapter.chapter_text,
    parsed?.work_completed?.[0],
    parsed?.decisions?.[0],
    resume?.current_focus,
    resume?.next_step,
  ].find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
}

export function useConversationChapters(sessionId: number, query = ''): ChapterIndexState {
  const [chapters, setChapters] = useState<ConversationChapter[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<ConversationChapterStatus | null>(null);
  const [revision, setRevision] = useState(0);

  const fetchPage = useCallback(async (cursor?: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(CHAPTER_PAGE_SIZE) });
    if (cursor) qs.set('cursor', cursor);
    if (query.trim()) qs.set('q', query.trim());
    const response = await fetch(`/api/coder/sessions/${sessionId}/chapters?${qs}`, { signal });
    if (!response.ok) throw new Error(`chapters request failed (${response.status})`);
    return await response.json() as ConversationChapterPage;
  }, [query, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setChapters([]);
    setNextCursor(null);
    setLoading(true);
    setError(false);
    setStatus(null);
    void fetchPage(undefined, controller.signal)
      .then((page) => {
        setChapters(Array.isArray(page.items) ? page.items : []);
        setNextCursor(page.next_cursor ?? null);
        setStatus(page.status ?? null);
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
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <span className="h-px w-3 bg-primary/60" />
        {label}
      </h4>
      <ul className="space-y-1.5 text-xs leading-relaxed text-foreground/80">
        {values.map((value, index) => (
          <li key={`${index}-${value}`} className="grid grid-cols-[6px_1fr] gap-2 break-words">
            <span className="mt-[7px] h-1 w-1 rounded-full bg-primary/70" />
            <span>{value}</span>
          </li>
        ))}
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
  embedded?: boolean;
}

export function ConversationChaptersTimeline({
  sessionId,
  chapters,
  nextCursor,
  loading,
  error,
  status: _status,
  loadMore,
  refresh,
  fallbackSummary,
  embedded = false,
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

  useEffect(() => {
    const selectFromTranscript = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: number; chapterId: number }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (!chapters.some((chapter) => chapter.id === detail.chapterId)) return;
      setOpenId(detail.chapterId);
      requestAnimationFrame(() => document
        .querySelector<HTMLElement>(`[data-chapter-card-id="${detail.chapterId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    };
    window.addEventListener('coder:chapter-selected', selectFromTranscript);
    return () => window.removeEventListener('coder:chapter-selected', selectFromTranscript);
  }, [chapters, sessionId]);

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

  if (!loading && chapters.length === 0 && !fallbackSummary) {
    return (
      <div className="px-4 py-10 text-center text-xs text-muted-foreground">
        <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl border border-border/60 bg-muted/35 text-muted-foreground/75">
          <BookOpen className="h-4 w-4" />
        </span>
        <p className="mx-auto max-w-[260px] leading-relaxed">
          {error ? t('messages.chapterLoadError') : t('messages.chapterEmpty')}
        </p>
      </div>
    );
  }

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
    <section className={cn(!embedded && 'rounded-lg border border-border/60 bg-muted/20', 'overflow-hidden')}>
      {!embedded && <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
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
      </header>}

      {rebuildError && (
        <div className="border-b border-border/50 px-3 py-1.5 text-[10px] text-destructive">
          {t('messages.chapterRebuildError')}
        </div>
      )}

      <div className="relative px-2 py-2">
        <div className="absolute bottom-5 left-[19px] top-5 w-px bg-gradient-to-b from-primary/50 via-border to-border/20" />
        {chapters.map((item) => {
          const chapter = details[item.id] ?? item;
          const open = openId === item.id;
          const parsed = safeJson<ConversationChapterContent>(chapter.chapter_json);
          const resume = safeJson<ConversationResumeContent>(chapter.resume_json);
          const source = sources[item.id] ?? EMPTY_SOURCE;
          const fileValues = parsed?.files?.map((file) => file.state ? `${file.path} — ${file.state}` : file.path);
          const formattedDate = chapter.created_at ? formatChapterDate(chapter.created_at, dateFormatter) : '';
          const kind = resolvedChapterKind(chapter);
          const preview = chapterPreviewText(chapter);
          return (
            <article
              key={item.id}
              data-chapter-card-id={item.id}
              className={cn('relative pl-6 transition-opacity', !open && 'opacity-90 hover:opacity-100')}
            >
              <span className={cn(
                'absolute left-[5px] top-[18px] z-10 grid h-3 w-3 place-items-center rounded-full border-2 border-background shadow-sm transition-all',
                open ? 'scale-110 bg-primary ring-4 ring-primary/10' : 'bg-muted-foreground/50',
              )}>
                {open && <span className="h-1 w-1 rounded-full bg-primary-foreground" />}
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = open ? null : item.id;
                  setOpenId(next);
                  if (next != null) {
                    window.dispatchEvent(new CustomEvent('coder:chapter-active', {
                      detail: { sessionId, chapterId: next },
                    }));
                  }
                }}
                className={cn(
                  'group mb-1 flex w-full items-start gap-2 rounded-lg border px-2.5 py-2.5 text-left transition-all',
                  open
                    ? 'border-primary/35 bg-primary/[0.07] shadow-[0_8px_24px_-18px_hsl(var(--primary))]'
                    : 'border-transparent hover:border-border/70 hover:bg-muted/45',
                )}
                aria-expanded={open}
                aria-current={open ? 'true' : undefined}
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className={cn(
                      'inline-flex h-4 items-center gap-1 rounded-full border px-1.5 text-[9px] font-semibold uppercase tracking-[0.08em]',
                      kind === 'context' && 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
                      kind === 'milestone' && 'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300',
                      kind === 'rebuild' && 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                    )}>
                      {kind === 'milestone' ? <Flag className="h-2.5 w-2.5" /> : kind === 'rebuild' ? <RefreshCw className="h-2.5 w-2.5" /> : <BookOpen className="h-2.5 w-2.5" />}
                      {t(`messages.chapterKind.${kind}`)}
                    </span>
                    <span className="text-[9px] tabular-nums text-muted-foreground/70">#{chapter.ordinal}</span>
                  </div>
                  <div className="truncate text-[13px] font-semibold leading-5 text-foreground/95">
                    {chapter.title || parsed?.title || t('messages.chapterNumber', { ordinal: chapter.ordinal })}
                  </div>
                  {!open && preview && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                      {preview}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-x-2 text-[9px] text-muted-foreground/80">
                    <span>{t(`messages.chapterSource.${chapter.source}`, { defaultValue: chapter.source })}</span>
                    <span>#{chapter.start_message_id}–#{chapter.end_message_id}</span>
                    {formattedDate && <span>{formattedDate}</span>}
                  </div>
                </div>
                <ChevronDown className={cn(
                  'mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-all group-hover:text-foreground',
                  open && 'rotate-180 text-primary',
                )} />
              </button>

              {open && (
                <div className="relative mx-1 mb-3 overflow-hidden rounded-lg border border-primary/15 bg-background/70 shadow-sm">
                  <span className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
                  <div className="space-y-3 p-3">
                  {detailLoading.has(item.id) && !details[item.id] ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('messages.chapterLoading')}
                    </div>
                  ) : (
                    <>
                      {(parsed?.summary || chapter.chapter_text) && (
                        <p className="whitespace-pre-wrap break-words border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed text-foreground/85">
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
                        <section className="rounded-md border border-border/50 bg-muted/35 p-2.5 text-xs text-foreground/75">
                          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('messages.chapterResumeState')}
                          </h4>
                          {resume.current_focus && <p>{resume.current_focus}</p>}
                          {resume.next_step && <p className="mt-1"><strong>{t('messages.chapterNextStep')}:</strong> {resume.next_step}</p>}
                        </section>
                      )}
                    </>
                  )}

                  <div className="flex flex-wrap gap-2 border-t border-border/50 pt-2.5">
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
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <MessageSquareText className="h-3 w-3" />
                      {source.open ? t('messages.chapterHideSource') : t('messages.chapterShowSource')}
                    </button>

                    <button
                      type="button"
                      onClick={() => window.dispatchEvent(new CustomEvent('coder:chapter-source', {
                        detail: {
                          sessionId,
                          chapterId: item.id,
                          startMessageId: item.start_message_id,
                          endMessageId: item.end_message_id,
                        },
                      }))}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary/10 px-2 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
                    >
                      <ArrowUpRight className="h-3 w-3" />
                      {t('messages.chapterGoToSource')}
                    </button>
                  </div>

                  {source.open && (
                    <div className="space-y-2 rounded-md border border-border/50 bg-muted/20 p-2.5">
                      {source.items.map((message) => (
                        <div key={message.id} className="text-xs">
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {t(`messages.chapterRole.${message.role}`, { defaultValue: message.role })} · #{message.id}
                          </div>
                            <div className="max-h-32 overflow-hidden whitespace-pre-wrap break-words border-l border-border/70 pl-2.5 text-foreground/75">
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

/** Persistent right-rail chapter browser and operational controls. */
export function ConversationChaptersPanel({
  sessionId,
  sessionStatus,
  fallbackSummary,
}: {
  sessionId: number;
  sessionStatus?: string | null;
  fallbackSummary?: string | null;
}) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<'summarize' | 'rebuild' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const chapterIndex = useConversationChapters(sessionId, query);
  const status = chapterIndex.status;
  const runActive = sessionStatus != null && sessionStatus !== 'idle' && sessionStatus !== 'error';

  const runAction = useCallback(async (kind: 'summarize' | 'rebuild') => {
    setAction(kind);
    setActionError(null);
    try {
      const response = await fetch(
        kind === 'summarize'
          ? `/api/coder/sessions/${sessionId}/summarize-and-clear`
          : `/api/coder/sessions/${sessionId}/chapters/rebuild`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(kind === 'rebuild' ? { body: JSON.stringify({ scope: 'all' }) } : {}),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      chapterIndex.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAction(null);
    }
  }, [chapterIndex.refresh, sessionId]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="space-y-2.5 border-b border-border/60 bg-gradient-to-b from-primary/[0.055] to-transparent p-3">
        <div className="rounded-lg border border-border/60 bg-background/70 p-2.5 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-primary/15 bg-primary/10 text-primary">
              <BookOpen className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'h-2 w-2 rounded-full shadow-[0_0_0_3px_hsl(var(--background))]',
                  status?.state === 'healthy' && 'bg-emerald-500',
                  status?.state === 'degraded' && 'bg-amber-500',
                  (!status || status.state === 'empty') && 'bg-muted-foreground/50',
                )} />
                <span className="truncate text-xs font-semibold">
                  {t(`messages.chapterState.${status?.state ?? 'empty'}`)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {t('messages.chapterOperationalHint')}
              </p>
            </div>
            <span className="ml-auto inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border/60 bg-muted/50 px-1.5 text-[10px] font-semibold tabular-nums text-foreground/75">
              {status?.chapter_count ?? chapterIndex.chapters.length}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[9px] text-muted-foreground">
          <span className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">{t('messages.chapterUnsummarized', { count: status?.unsummarized_messages ?? 0 })}</span>
          <span className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">{t('messages.chapterBoundary', { id: status?.boundary_id ?? '—' })}</span>
          <span className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">{t('messages.chapterLlmCount', { count: status?.counters.summarized ?? 0 })}</span>
          <span className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">{t('messages.chapterFallbackCount', { count: status?.counters.deterministic_fallbacks ?? 0 })}</span>
        </div>
        {status?.state === 'degraded' && status.last_attempt?.error_message && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-700 dark:text-amber-300">
            {status.last_attempt.error_message}
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('messages.chapterSearch')}
            className="h-8 w-full rounded-md border border-input bg-background/80 pl-8 pr-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={runActive || action != null}
            title={runActive ? t('messages.chapterRunActive') : undefined}
            onClick={() => void runAction('summarize')}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-[11px] font-semibold text-primary-foreground shadow-sm transition-all hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === 'summarize' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
            {t('messages.chapterSummarizeNow')}
          </button>
          <button
            type="button"
            disabled={runActive || action != null}
            title={runActive ? t('messages.chapterRunActive') : undefined}
            onClick={() => void runAction('rebuild')}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-input bg-background/80 px-2 text-[11px] font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action === 'rebuild' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('messages.chapterRebuildHistory')}
          </button>
        </div>
        {runActive && <p className="text-[10px] text-muted-foreground">{t('messages.chapterRunActive')}</p>}
        {actionError && <p className="text-[10px] text-destructive">{actionError}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConversationChaptersTimeline
          sessionId={sessionId}
          fallbackSummary={fallbackSummary}
          embedded
          {...chapterIndex}
        />
      </div>
    </div>
  );
}

/** Interactive timeline marker rendered when a chapter's original range is loaded. */
export function ConversationChapterDivider({
  chapter,
  active = false,
  onActivate,
}: {
  chapter: ConversationChapter;
  active?: boolean;
  onActivate?: (chapterId: number) => void;
}) {
  const { t } = useTranslation('chat');
  const kind = resolvedChapterKind(chapter);
  const preview = chapterPreviewText(chapter);
  const title = chapter.title || t('messages.chapterNumber', { ordinal: chapter.ordinal });

  const activate = () => {
    onActivate?.(chapter.id);
    window.dispatchEvent(new CustomEvent('coder:chapter-selected', {
      detail: { sessionId: chapter.session_id, chapterId: chapter.id },
    }));
  };

  return (
    <div
      className="group/chapter-marker relative my-2 grid grid-cols-[22px_minmax(0,auto)_1fr] items-center gap-2 py-1"
      data-chapter-id={chapter.id}
      data-active={active || undefined}
    >
      <span className="relative block h-9 w-[22px]" aria-hidden="true">
        <span className="absolute bottom-0 left-[10px] top-0 w-px bg-border/65" />
        <span className={cn(
          'absolute left-[6px] top-[14px] h-[9px] w-[9px] rounded-full border-2 border-background shadow-sm transition-all',
          active
            ? 'scale-110 bg-primary ring-4 ring-primary/10'
            : 'bg-muted-foreground/45 group-hover/chapter-marker:bg-primary/70',
        )} />
        <span className={cn(
          'absolute left-[10px] top-[18px] h-px w-3 transition-colors',
          active ? 'bg-primary' : 'bg-border group-hover/chapter-marker:bg-primary/60',
        )} />
      </span>

      <Tooltip delayDuration={180}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={activate}
            aria-pressed={active}
            aria-label={t('messages.chapterOpenPanel', { title })}
            className={cn(
              'flex min-w-0 max-w-[440px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left shadow-sm transition-all',
              active
                ? 'border-primary/40 bg-primary/10 text-foreground shadow-[0_7px_22px_-16px_hsl(var(--primary))]'
                : 'border-border/60 bg-background/80 text-muted-foreground hover:-translate-y-px hover:border-primary/30 hover:bg-background hover:text-foreground hover:shadow-md',
            )}
          >
            <span className={cn(
              'grid h-5 w-5 shrink-0 place-items-center rounded-md',
              kind === 'milestone' ? 'bg-violet-500/10 text-violet-500' : kind === 'rebuild' ? 'bg-amber-500/10 text-amber-500' : 'bg-sky-500/10 text-sky-500',
            )}>
              {kind === 'milestone' ? <Flag className="h-3 w-3" /> : kind === 'rebuild' ? <RefreshCw className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[10px] font-semibold leading-4 text-foreground/90">{title}</span>
              <span className="block text-[8px] uppercase tracking-[0.1em] text-muted-foreground/70">
                {t(`messages.chapterKind.${kind}`)} · #{chapter.ordinal}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="center"
          sideOffset={10}
          className="w-[min(330px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border/70 bg-popover p-0 text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border/60 bg-gradient-to-br from-primary/10 via-transparent to-transparent px-3 py-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-primary">
                {t(`messages.chapterKind.${kind}`)}
              </span>
              <span className="text-[9px] tabular-nums text-muted-foreground">
                #{chapter.start_message_id}–#{chapter.end_message_id}
              </span>
            </div>
            <p className="text-xs font-semibold leading-5 text-foreground">{title}</p>
          </div>
          <div className="px-3 py-2.5">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {t('messages.chapterPreviewLabel')}
            </p>
            <p className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-4 text-foreground/80">
              {preview || t('messages.chapterPreviewEmpty')}
            </p>
            <p className="mt-2 flex items-center gap-1 text-[9px] font-medium text-primary">
              {t('messages.chapterOpenHint')}
              <ArrowUpRight className="h-2.5 w-2.5" />
            </p>
          </div>
        </TooltipContent>
      </Tooltip>

      <span className={cn(
        'h-px min-w-4 bg-gradient-to-r transition-colors',
        active ? 'from-primary/70 to-primary/0' : 'from-border/80 to-border/0',
      )} />
    </div>
  );
}
