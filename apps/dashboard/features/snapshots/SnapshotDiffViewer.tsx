import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, MessageSquarePlus, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { prompt } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import type { SnapshotFileDiff, SnapshotHunk, SnapshotHunkLine, SnapshotReviewComment } from './types.js';

export interface AddReviewCommentInput {
  baselineId: number;
  filePath: string;
  hunkFingerprint?: string | null;
  oldLine?: number | null;
  newLine?: number | null;
  diffExcerpt?: string | null;
  body: string;
}

interface Props {
  diff: SnapshotFileDiff;
  comments: SnapshotReviewComment[];
  onAcceptHunk: (fingerprint: string) => Promise<void>;
  onRevertHunk: (fingerprint: string) => Promise<void>;
  onAcceptFile: () => Promise<void>;
  onRevertFile: () => Promise<void>;
  onAddComment: (input: AddReviewCommentInput) => Promise<void>;
  onUpdateComment: (id: number, patch: Partial<Pick<SnapshotReviewComment, 'status'>>) => Promise<void>;
  onAutoReview: () => Promise<void>;
  onSubmitReview: () => Promise<void>;
  onExpandContext: (side: 'before' | 'after') => void;
  busy: boolean;
  reviewBusy: boolean;
  canSubmitReview: boolean;
}

function hunkExcerpt(hunk: SnapshotHunk, focus?: SnapshotHunkLine): string {
  const lines = focus
    ? [focus]
    : hunk.lines.slice(0, 80);
  return [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...lines.map((line) => {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      return `${prefix}${line.content}`;
    }),
  ].join('\n');
}

function lineLabel(line: SnapshotHunkLine): string {
  if (line.oldLine != null && line.newLine != null) return `${line.oldLine}/${line.newLine}`;
  if (line.oldLine != null) return String(line.oldLine);
  if (line.newLine != null) return String(line.newLine);
  return '';
}

function isVisibleComment(comment: SnapshotReviewComment): boolean {
  return comment.status !== 'dismissed' && comment.status !== 'sent';
}

function matchesLine(comment: SnapshotReviewComment, line: SnapshotHunkLine): boolean {
  if (!isVisibleComment(comment)) return false;
  if (comment.new_line != null && line.newLine != null) return comment.new_line === line.newLine;
  if (comment.old_line != null && line.oldLine != null) return comment.old_line === line.oldLine;
  return false;
}

function InlineReviewComment({
  comment,
  onUpdate,
  busy,
}: {
  comment: SnapshotReviewComment;
  onUpdate: Props['onUpdateComment'];
  busy: boolean;
}) {
  const { t } = useTranslation('projects');
  return (
    <div className="ml-[72px] mr-3 my-1 rounded border bg-background/95 px-3 py-2 text-xs font-sans whitespace-normal">
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

function ReviewCommentList({
  comments,
  onUpdate,
  busy,
}: {
  comments: SnapshotReviewComment[];
  onUpdate: Props['onUpdateComment'];
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
              <div className="text-muted-foreground whitespace-pre-wrap">
                {comment.suggested_fix}
              </div>
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

function HunkBlock({
  hunk,
  comments,
  onAccept,
  onRevert,
  onAddComment,
  onUpdateComment,
  onExpandContext,
  busy,
}: {
  hunk: SnapshotHunk;
  comments: SnapshotReviewComment[];
  onAccept: () => void;
  onRevert: () => void;
  onAddComment: (line?: SnapshotHunkLine) => Promise<void>;
  onUpdateComment: Props['onUpdateComment'];
  onExpandContext: (side: 'before' | 'after') => void;
  busy: boolean;
}) {
  const { t } = useTranslation('projects');
  const decided = hunk.decision !== 'pending';
  const hunkComments = comments.filter((comment) =>
    isVisibleComment(comment) &&
    comment.hunk_fingerprint === hunk.fingerprint &&
    comment.old_line == null &&
    comment.new_line == null,
  );
  return (
    <div className={cn('border rounded-md overflow-hidden bg-card min-w-0', decided && 'opacity-60')}>
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/30 border-b text-[11px] font-mono">
        <span className="text-muted-foreground">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-700 dark:text-emerald-400">+{hunk.addedCount}</span>
          <span className="text-rose-700 dark:text-rose-400">-{hunk.removedCount}</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" disabled={busy} onClick={() => void onAddComment()} title={t('snapshotDiff.commentHunk')}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
          {hunk.decision === 'kept' && <Badge variant="outline" className="text-[9px]">{t('snapshotDiff.kept')}</Badge>}
          {hunk.decision === 'reverted' && <Badge variant="outline" className="text-[9px]">{t('snapshotDiff.reverted')}</Badge>}
        </div>
      </div>
      {hunkComments.length > 0 && (
        <div className="border-b bg-muted/10 py-1">
          {hunkComments.map((comment) => (
            <InlineReviewComment
              key={comment.id}
              comment={comment}
              onUpdate={onUpdateComment}
              busy={busy}
            />
          ))}
        </div>
      )}
      <div className="font-mono text-[11.5px] leading-snug overflow-x-auto">
        <div className="min-w-max">
        {hunk.canExpandBefore && (
          <button
            type="button"
            onClick={() => onExpandContext('before')}
            className="block min-w-full w-max text-left px-3 py-1 text-[11px] text-muted-foreground bg-muted/20 hover:bg-muted/40"
          >
            {t('snapshotDiff.showLinesAbove', { count: hunk.hiddenBefore })}
          </button>
        )}
          {hunk.lines.map((line, i) => {
            const lineComments = comments.filter((comment) =>
              comment.hunk_fingerprint === hunk.fingerprint && matchesLine(comment, line),
            );
            const bg =
              line.type === 'add'
                ? 'bg-emerald-500/10 dark:bg-emerald-500/15'
                : line.type === 'remove'
                  ? 'bg-rose-500/10 dark:bg-rose-500/15'
                  : '';
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
            return (
              <div key={i} className="min-w-full w-max">
                <div className={cn('group flex items-start min-w-full w-max px-3 whitespace-pre', bg)}>
                  <span className="select-none text-muted-foreground w-12 text-right pr-2 flex-none">{lineLabel(line)}</span>
                  <span className="select-none text-muted-foreground w-3 flex-none">{prefix}</span>
                  <span className="pr-8">{line.content || ' '}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onAddComment(line)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-1"
                    title={t('snapshotDiff.commentLine')}
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                  </button>
                </div>
                {lineComments.map((comment) => (
                  <InlineReviewComment
                    key={comment.id}
                    comment={comment}
                    onUpdate={onUpdateComment}
                    busy={busy}
                  />
                ))}
              </div>
            );
          })}
        {hunk.canExpandAfter && (
          <button
            type="button"
            onClick={() => onExpandContext('after')}
            className="block min-w-full w-max text-left px-3 py-1 text-[11px] text-muted-foreground bg-muted/20 hover:bg-muted/40"
          >
            {t('snapshotDiff.showLinesBelow', { count: hunk.hiddenAfter })}
          </button>
        )}
        </div>
      </div>
      {!decided && (
        <div className="flex items-center justify-end gap-1 px-3 py-1.5 bg-muted/20 border-t">
          <Button size="sm" variant="ghost" onClick={onAccept} disabled={busy} className="h-7 text-xs">
            {t('snapshotDiff.keepHunk')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRevert} disabled={busy} className="h-7 text-xs">
            {t('snapshotDiff.undoHunk')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SnapshotDiffViewer({
  diff,
  comments,
  onAcceptHunk,
  onRevertHunk,
  onAcceptFile,
  onRevertFile,
  onAddComment,
  onUpdateComment,
  onAutoReview,
  onSubmitReview,
  onExpandContext,
  busy,
  reviewBusy,
  canSubmitReview,
}: Props) {
  const { t } = useTranslation('projects');
  const [localBusy, setLocalBusy] = useState(false);
  const isBusy = busy || localBusy || reviewBusy;
  const fileComments = useMemo(
    () => comments.filter((c) => c.baseline_id === diff.baseline.id),
    [comments, diff.baseline.id],
  );
  const fileLevelComments = useMemo(
    () => fileComments.filter((c) =>
      isVisibleComment(c) &&
      c.hunk_fingerprint == null &&
      c.old_line == null &&
      c.new_line == null,
    ),
    [fileComments],
  );

  const addComment = async (hunk: SnapshotHunk | null, line?: SnapshotHunkLine) => {
    const text = await prompt({
      title: line ? t('snapshotDiff.commentLine') : hunk ? t('snapshotDiff.commentHunk') : t('snapshotDiff.commentFile'),
      placeholder: t('snapshotDiff.reviewFeedbackPlaceholder'),
      confirmLabel: t('snapshotDiff.addComment'),
      validate: (value) => (value.trim().length ? null : t('snapshotDiff.commentRequired')),
    });
    if (!text) return;
    setLocalBusy(true);
    try {
      await onAddComment({
        baselineId: diff.baseline.id,
        filePath: diff.baseline.filePath,
        hunkFingerprint: hunk?.fingerprint ?? null,
        oldLine: line?.oldLine ?? null,
        newLine: line?.newLine ?? null,
        diffExcerpt: hunk ? hunkExcerpt(hunk, line) : null,
        body: text,
      });
    } finally {
      setLocalBusy(false);
    }
  };

  const actions = (
    <div className="flex gap-1.5 flex-shrink-0 overflow-x-auto">
      <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => void addComment(null)} className="h-7 text-xs">
        <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
        {t('snapshotDiff.fileComment')}
      </Button>
      <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setLocalBusy(true); onAutoReview().finally(() => setLocalBusy(false)); }} className="h-7 text-xs">
        <Bot className="h-3.5 w-3.5 mr-1" />
        {t('snapshotDiff.autoReview')}
      </Button>
      <Button size="sm" variant="default" disabled={isBusy || !canSubmitReview} onClick={() => { setLocalBusy(true); onSubmitReview().finally(() => setLocalBusy(false)); }} className="h-7 text-xs">
        <Send className="h-3.5 w-3.5 mr-1" />
        {t('snapshotDiff.sendReview')}
      </Button>
      <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setLocalBusy(true); onAcceptFile().finally(() => setLocalBusy(false)); }} className="h-7 text-xs">
        {t('snapshotDiff.keepFile')}
      </Button>
      <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { setLocalBusy(true); onRevertFile().finally(() => setLocalBusy(false)); }} className="h-7 text-xs">
        {t('snapshotDiff.revertFile')}
      </Button>
    </div>
  );

  if (diff.diffDisabled) {
    return (
      <div className="flex flex-col h-full min-h-0 min-w-0">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-card gap-2">
          <div className="font-mono text-xs truncate flex-1 min-w-0">{diff.baseline.filePath}</div>
          {actions}
        </div>
        {fileLevelComments.length > 0 && (
          <div className="border-b p-2 max-h-48 overflow-y-auto">
            <ReviewCommentList comments={fileLevelComments} onUpdate={onUpdateComment} busy={isBusy} />
          </div>
        )}
        <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3 text-sm text-muted-foreground">
          <span>{t('snapshotDiff.tooLarge')}</span>
          <span>{t('snapshotDiff.largeFileHint')}</span>
        </div>
      </div>
    );
  }

  if (diff.hunks.length === 0) {
    return (
      <div className="flex flex-col h-full min-h-0 min-w-0">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-card gap-2">
          <div className="font-mono text-xs truncate flex-1 min-w-0">{diff.baseline.filePath}</div>
          {actions}
        </div>
        {fileLevelComments.length > 0 && (
          <div className="border-b p-2 max-h-48 overflow-y-auto">
            <ReviewCommentList comments={fileLevelComments} onUpdate={onUpdateComment} busy={isBusy} />
          </div>
        )}
        <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3 text-sm text-muted-foreground">
          <span>{t('snapshotDiff.noRemainingChanges', { file: diff.baseline.filePath })}</span>
          <span>{t('snapshotDiff.matchesBaseline')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-card">
        <div className="font-mono text-xs truncate flex-1 min-w-0">{diff.baseline.filePath}</div>
        {actions}
      </div>
      {fileLevelComments.length > 0 && (
        <div className="border-b p-2 max-h-48 overflow-y-auto">
          <ReviewCommentList comments={fileLevelComments} onUpdate={onUpdateComment} busy={isBusy} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 bg-background">
        {diff.hunks.map((h) => (
          <HunkBlock
            key={h.fingerprint}
            hunk={h}
            comments={fileComments}
            busy={isBusy}
            onUpdateComment={onUpdateComment}
            onExpandContext={onExpandContext}
            onAddComment={(line) => addComment(h, line)}
            onAccept={() => { setLocalBusy(true); onAcceptHunk(h.fingerprint).finally(() => setLocalBusy(false)); }}
            onRevert={() => { setLocalBusy(true); onRevertHunk(h.fingerprint).finally(() => setLocalBusy(false)); }}
          />
        ))}
      </div>
    </div>
  );
}
