import { Check, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import type { SnapshotReviewComment } from './types.js';

interface Props {
  comments: SnapshotReviewComment[];
  selectedBaselineId: number | null;
  busy: boolean;
  canSubmit: boolean;
  onSelectBaseline: (baselineId: number) => void;
  onUpdateComment: (id: number, patch: Partial<Pick<SnapshotReviewComment, 'status'>>) => Promise<void>;
  onSubmit: () => Promise<void>;
}

function statusLabel(comment: SnapshotReviewComment): string {
  if (comment.source === 'manual') return comment.status === 'open' ? 'ready' : comment.status;
  if (comment.status === 'open') return 'needs accept';
  return comment.status;
}

function locationLabel(comment: SnapshotReviewComment): string {
  const line = comment.new_line ?? comment.old_line;
  if (line != null) return `line ${line}`;
  if (comment.hunk_fingerprint) return `hunk ${comment.hunk_fingerprint.slice(0, 8)}`;
  return 'file';
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
  const visible = comments.filter((c) => c.status !== 'dismissed' && c.status !== 'sent');
  if (visible.length === 0) return null;

  const acceptedCount = visible.filter((c) =>
    (c.source === 'manual' && c.status === 'open') ||
    (c.source === 'auto' && c.status === 'accepted'),
  ).length;

  return (
    <div className="border-b bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/20">
        <div className="text-xs font-medium">
          Review queue{' '}
          <span className="text-muted-foreground">
            ({visible.length} item{visible.length === 1 ? '' : 's'}, {acceptedCount} ready)
          </span>
        </div>
        <Button
          size="sm"
          variant="default"
          disabled={busy || !canSubmit}
          onClick={() => void onSubmit()}
          className="h-7 text-xs"
        >
          <Send className="h-3.5 w-3.5 mr-1" />
          Send review
        </Button>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y">
        {visible.map((comment) => (
          <div
            key={comment.id}
            className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 text-xs"
          >
            <button
              type="button"
              onClick={() => onSelectBaseline(comment.baseline_id)}
              className="min-w-0 text-left space-y-1"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Badge variant="outline" className="text-[9px] uppercase">
                  {comment.source}
                </Badge>
                {comment.severity && (
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {comment.severity}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[9px] uppercase">
                  {statusLabel(comment)}
                </Badge>
                <span className="font-mono text-muted-foreground truncate">
                  {locationLabel(comment)}
                </span>
              </div>
              <div className="font-mono truncate">
                {selectedBaselineId === comment.baseline_id ? '› ' : ''}
                {comment.file_path}
              </div>
              <div className="text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                {comment.body}
              </div>
            </button>
            {comment.source === 'auto' && comment.status === 'open' && (
              <div className="flex items-start gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void onUpdateComment(comment.id, { status: 'accepted' })}
                >
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => void onUpdateComment(comment.id, { status: 'dismissed' })}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
