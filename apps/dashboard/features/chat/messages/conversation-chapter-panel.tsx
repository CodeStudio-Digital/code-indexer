import { useTranslation } from 'react-i18next';
import { useCallback, useState } from 'react';
import { BookOpen, Loader2, RefreshCw, Search, WandSparkles } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { useConversationChapters } from './conversation-chapter-index.js';
import { ConversationChaptersTimeline } from './conversation-chapter-timeline.js';

/** Persistent right-rail chapter browser and operational controls. */
export function ConversationChaptersPanel({
  sessionId,
  sessionStatus,
  fallbackSummary,
}: {
  sessionId: string;
  sessionStatus?: string | null;
  fallbackSummary?: string | null;
}) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<'summarize' | 'rebuild' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const chapterIndex = useConversationChapters(sessionId, query, { pageSize: 50 });
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
      window.dispatchEvent(new CustomEvent('coder:chapters-changed', { detail: { sessionId } }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAction(null);
    }
  }, [sessionId]);

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
          <span className="rounded-md border border-border/50 bg-background/45 px-2 py-1.5">{t('messages.chapterBoundary', { id: status?.boundary_seq ?? '—' })}</span>
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
