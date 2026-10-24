import type { ConversationChapter, ConversationChapterContent, ConversationChapterSourceMessage, ConversationChapterSourcePage, ConversationResumeContent } from '../types.js';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronDown, FileText, Flag, Loader2, MessageSquareText, RefreshCw } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { type ChapterIndexState } from './conversation-chapter-index.js';
import { SOURCE_PAGE_SIZE, safeJson, formatChapterDate, resolvedChapterKind, chapterPreviewText, DetailSection, sourceMessageText } from './conversation-chapter-content.js';

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
  sessionId: string;
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
  refresh: _refresh,
  fallbackSummary,
  embedded = false,
}: ConversationChaptersTimelineProps) {
  const { t, i18n } = useTranslation('chat');
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ConversationChapter>>({});
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<Record<string, SourceState>>({});
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
      window.dispatchEvent(new CustomEvent('coder:chapters-changed', { detail: { sessionId } }));
    } catch {
      setRebuildError(true);
    } finally {
      setRebuilding(false);
    }
  }, [sessionId]);

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
      const detail = (event as CustomEvent<{ sessionId: string; chapterId: string }>).detail;
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

  const loadSource = useCallback(async (chapterId: string, cursor?: string) => {
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
                    <span>#{chapter.start_message_seq}–#{chapter.end_message_seq}</span>
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
                          startMessageSeq: item.start_message_seq,
                          endMessageSeq: item.end_message_seq,
                          expandConversation: true,
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
                            {t(`messages.chapterRole.${message.role}`, { defaultValue: message.role })} · #{message.seq}
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
