/**
 * Presentational review-comment components, extracted from the diff viewer.
 * `InlineReviewComment` renders one comment beneath its anchor line/hunk;
 * `ReviewCommentList` renders the file-level comment box above the diff body.
 */
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Badge } from '../../../components/ui/badge.js';
import type { SnapshotReviewComment } from '../types.js';

export type OnUpdateComment = (
  id: string,
  patch: Partial<Pick<SnapshotReviewComment, 'status'>>,
) => void | Promise<void>;

export function InlineReviewComment({
  comment,
  onUpdate,
  busy,
}: {
  comment: SnapshotReviewComment;
  onUpdate: OnUpdateComment;
  busy: boolean;
}) {
  const { t } = useTranslation('projects');
  return (
    <div className="ml-[72px] mr-3 my-1 max-w-[48rem] rounded border bg-background/95 px-3 py-2 text-xs font-sans whitespace-normal">
      <div className="flex items-center gap-1.5 mb-1">
        <Badge variant="outline" className="text-[9px] uppercase">
          {comment.source}
        </Badge>
        {comment.severity && (
          <Badge variant="outline" className="text-[9px] uppercase">
            {comment.severity}
          </Badge>
        )}
        <span className="text-muted-foreground">{comment.status}</span>
      </div>
      <div className="whitespace-pre-wrap leading-snug">{comment.body}</div>
      {comment.suggested_fix && (
        <div className="mt-1 text-muted-foreground whitespace-pre-wrap">{comment.suggested_fix}</div>
      )}
      {comment.source === 'auto' && comment.status === 'open' && (
        <div className="mt-2 flex gap-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onUpdate(comment.id, { status: 'accepted' })}>
            <Check className="h-3.5 w-3.5 mr-1" />
            {t('snapshotDiff.accept')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => onUpdate(comment.id, { status: 'dismissed' })}>
            <X className="h-3.5 w-3.5 mr-1" />
            {t('snapshotDiff.dismiss')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function ReviewCommentList({
  comments,
  onUpdate,
  busy,
}: {
  comments: SnapshotReviewComment[];
  onUpdate: OnUpdateComment;
  busy: boolean;
}) {
  const { t } = useTranslation('projects');
  const visible = comments.filter((c) => c.status !== 'dismissed' && c.status !== 'sent');
  if (visible.length === 0) return null;
  return (
    <div className="border rounded-md bg-card overflow-hidden">
      <div className="px-3 py-1.5 border-b bg-muted/30 text-[11px] font-medium">
        {t('snapshotDiff.reviewComments')}
      </div>
      <div className="divide-y">
        {visible.map((comment) => (
          <div key={comment.id} className="p-3 text-xs space-y-2">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[9px] uppercase">
                {comment.source}
              </Badge>
              {comment.severity && (
                <Badge variant="outline" className="text-[9px] uppercase">
                  {comment.severity}
                </Badge>
              )}
              <span className="text-muted-foreground font-mono">
                {comment.new_line ?? comment.old_line ?? t('snapshotDiff.file')}
              </span>
              <span className="ml-auto text-muted-foreground">{comment.status}</span>
            </div>
            <div className="whitespace-pre-wrap leading-snug">{comment.body}</div>
            {comment.suggested_fix && (
              <div className="text-muted-foreground whitespace-pre-wrap">{comment.suggested_fix}</div>
            )}
            {comment.source === 'auto' && comment.status === 'open' && (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => onUpdate(comment.id, { status: 'accepted' })}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  {t('snapshotDiff.accept')}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => onUpdate(comment.id, { status: 'dismissed' })}>
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t('snapshotDiff.dismiss')}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
