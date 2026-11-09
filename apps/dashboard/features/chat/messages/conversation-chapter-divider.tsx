import type { ConversationChapter, ConversationChapterContent, ConversationResumeContent } from '../types.js';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { BookOpen, ChevronDown, Flag, Loader2, MessageSquareText, RefreshCw } from 'lucide-react';
import { resolvedChapterKind, chapterPreviewText, safeJson, DetailSection } from './conversation-chapter-content.js';

/** Compact chapter node used by the main chronological transcript timeline. */
export function ConversationChapterDivider({
  chapter,
  active = false,
  expanded = false,
  detail,
  detailLoading = false,
  conversationExpanded = false,
  conversationLoading = false,
  conversationError = false,
  onActivate,
  onToggle,
  onToggleConversation,
}: {
  chapter: ConversationChapter;
  active?: boolean;
  expanded?: boolean;
  detail?: ConversationChapter;
  detailLoading?: boolean;
  conversationExpanded?: boolean;
  conversationLoading?: boolean;
  conversationError?: boolean;
  onActivate?: (chapterId: string) => void;
  onToggle?: (chapter: ConversationChapter) => void;
  onToggleConversation?: (chapter: ConversationChapter) => void;
}) {
  const { t } = useTranslation('chat');
  const resolved = detail ?? chapter;
  const kind = resolvedChapterKind(resolved);
  const preview = chapterPreviewText(resolved);
  const title = resolved.title || t('messages.chapterNumber', { ordinal: resolved.ordinal });
  const parsed = safeJson<ConversationChapterContent>(resolved.chapter_json);
  const resume = safeJson<ConversationResumeContent>(resolved.resume_json);
  const fileValues = parsed?.files?.map((file) => (
    file.state ? `${file.path} — ${file.state}` : file.path
  ));

  const activate = () => {
    onActivate?.(chapter.id);
    onToggle?.(chapter);
    window.dispatchEvent(new CustomEvent('coder:chapter-selected', {
      detail: { sessionId: chapter.session_id, chapterId: chapter.id },
    }));
  };

  return (
    <article
      className="group/chapter-marker relative py-1.5 pl-8"
      data-chapter-id={chapter.id}
      data-active={active || undefined}
    >
      <span className={cn(
          'absolute left-[10px] top-[27px] z-10 h-[9px] w-[9px] rounded-full border-2 border-background shadow-sm transition-all',
          active
            ? 'scale-110 bg-primary ring-4 ring-primary/10'
            : 'bg-muted-foreground/45 group-hover/chapter-marker:bg-primary/70',
        )} aria-hidden="true" />
      <span className={cn(
          'absolute left-[18px] top-[31px] h-px w-5 transition-colors',
          active ? 'bg-primary' : 'bg-border group-hover/chapter-marker:bg-primary/60',
        )} aria-hidden="true" />

      <div className={cn(
        'overflow-hidden rounded-lg border bg-background/80 shadow-sm transition-colors',
        active || expanded ? 'border-primary/35 bg-primary/[0.045]' : 'border-border/60 hover:border-primary/25',
      )}>
        <button
          type="button"
          onClick={activate}
          aria-expanded={expanded}
          aria-label={t('messages.chapterOpenPanel', { title })}
          className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left"
        >
          <span className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-md',
            kind === 'milestone' ? 'bg-violet-500/10 text-violet-500' : kind === 'rebuild' ? 'bg-amber-500/10 text-amber-500' : 'bg-sky-500/10 text-sky-500',
          )}>
            {kind === 'milestone' ? <Flag className="h-3.5 w-3.5" /> : kind === 'rebuild' ? <RefreshCw className="h-3.5 w-3.5" /> : <BookOpen className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-semibold leading-4 text-foreground/95">{title}</span>
            <span className="block text-[8px] uppercase tracking-[0.1em] text-muted-foreground/70">
              {t(`messages.chapterKind.${kind}`)} · #{chapter.ordinal}
            </span>
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </button>

        {expanded && (
          <div className="space-y-3 border-t border-border/55 px-3 py-3">
            {detailLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('messages.chapterLoading')}
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words border-l-2 border-primary/40 pl-2.5 text-xs leading-relaxed text-foreground/85">
                  {parsed?.summary || resolved.chapter_text || preview || t('messages.chapterPreviewEmpty')}
                </p>
                <DetailSection label={t('messages.chapterUserRequests')} values={parsed?.user_requests} />
                <DetailSection label={t('messages.chapterDecisions')} values={parsed?.decisions} />
                <DetailSection label={t('messages.chapterWorkCompleted')} values={parsed?.work_completed} />
                <DetailSection label={t('messages.chapterFiles')} values={fileValues} />
                <DetailSection label={t('messages.chapterOpenIssues')} values={parsed?.open_issues} />
                <DetailSection label={t('messages.chapterResolvedIssues')} values={parsed?.resolved_issues} />
                {(resume?.current_focus || resume?.next_step) && (
                  <section className="rounded-md border border-border/50 bg-muted/30 p-2.5 text-xs text-foreground/75">
                    {resume.current_focus && <p>{resume.current_focus}</p>}
                    {resume.next_step && <p className="mt-1"><strong>{t('messages.chapterNextStep')}:</strong> {resume.next_step}</p>}
                  </section>
                )}
              </>
            )}
            <button
              type="button"
              disabled={conversationLoading && !conversationExpanded}
              onClick={() => onToggleConversation?.(chapter)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {conversationLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquareText className="h-3 w-3" />}
              {conversationExpanded ? t('messages.chapterHideSource') : t('messages.chapterShowSource')}
            </button>
            {conversationError && (
              <p className="text-[10px] text-destructive">{t('messages.chapterSourceLoadError')}</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
