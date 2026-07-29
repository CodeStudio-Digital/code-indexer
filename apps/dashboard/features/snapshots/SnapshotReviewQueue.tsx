import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible.js';
import { cn } from '../../lib/utils.js';
import type { SnapshotReviewComment } from './types.js';

interface Props {
  comments: SnapshotReviewComment[];
  selectedBaselineId: string | null;
  busy: boolean;
  canSubmit: boolean;
  onSelectBaseline: (baselineId: string) => void;
  onUpdateComment: (id: string, patch: Partial<Pick<SnapshotReviewComment, 'status'>>) => Promise<void>;
  onSubmit: () => Promise<void>;
}

export function SnapshotReviewQueue({
  comments,
  selectedBaselineId,
  busy,
  canSubmit,
  onSelectBaseline,
  onUpdateComment,
  onSubmit,
}: Props) {
  const { t } = useTranslation('projects');
  const [open, setOpen] = useState(false);
  const visible = comments.filter((c) => c.status !== 'dismissed' && c.status !== 'sent');
  if (visible.length === 0) return null;

  const acceptedCount = visible.filter((c) =>
    (c.source === 'manual' && c.status === 'open') ||
    (c.source === 'auto' && c.status === 'accepted'),
  ).length;

  const statusLabel = (comment: SnapshotReviewComment): string => {
    if (comment.source === 'manual' && comment.status === 'open') return t('snapshotReview.status.ready');
    if (comment.source === 'auto' && comment.status === 'open') return t('snapshotReview.status.needsAccept');
    return t(`snapshotReview.status.${comment.status}`);
  };

  const locationLabel = (comment: SnapshotReviewComment): string => {
    const line = comment.new_line ?? comment.old_line;
    if (line != null) return t('snapshotReview.location.line', { line });
    if (comment.hunk_fingerprint) {
      return t('snapshotReview.location.hunk', { hunk: comment.hunk_fingerprint.slice(0, 8) });
    }
    return t('snapshotReview.location.file');
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b bg-card">
      <div className="flex min-h-9 items-center gap-2 bg-muted/20 px-2.5 py-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={open ? t('snapshotReview.collapse') : t('snapshotReview.expand')}
          >
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
            <span className="truncate text-xs font-medium">{t('snapshotReview.title')}</span>
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
              {visible.length}
            </Badge>
            <span className="truncate text-[10px] text-muted-foreground">
              {t('snapshotReview.readyCount', { count: acceptedCount })}
            </span>
          </button>
        </CollapsibleTrigger>
        <Button
          size="sm"
          variant="default"
          disabled={busy || !canSubmit}
          onClick={() => void onSubmit()}
          className="h-7 shrink-0 px-2 text-xs"
        >
          <Send className="h-3.5 w-3.5" />
          {t('snapshotReview.send')}
        </Button>
      </div>
      <CollapsibleContent>
        <div className="max-h-40 overflow-y-auto divide-y border-t">
          {visible.map((comment) => (
            <div
              key={comment.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-xs"
            >
              <button
                type="button"
                onClick={() => onSelectBaseline(comment.baseline_id)}
                className={cn(
                  'min-w-0 rounded px-1 py-0.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selectedBaselineId === comment.baseline_id && 'bg-muted/60',
                )}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">
                    {t(`snapshotReview.source.${comment.source}`)}
                  </Badge>
                  {comment.severity && (
                    <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">
                      {comment.severity}
                    </Badge>
                  )}
                  <Badge variant="outline" className="h-4 px-1 text-[8px] uppercase">
                    {statusLabel(comment)}
                  </Badge>
                  <span className="truncate font-mono font-medium">{comment.file_path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {locationLabel(comment)}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{comment.body}</div>
              </button>
              {comment.source === 'auto' && comment.status === 'open' && (
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={busy}
                    onClick={() => void onUpdateComment(comment.id, { status: 'accepted' })}
                    aria-label={t('snapshotDiff.accept')}
                    title={t('snapshotDiff.accept')}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="h-7 w-7"
                    disabled={busy}
                    onClick={() => void onUpdateComment(comment.id, { status: 'dismissed' })}
                    aria-label={t('snapshotDiff.dismiss')}
                    title={t('snapshotDiff.dismiss')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
