import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, MessageSquarePlus, RotateCcw, Send } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { prompt } from '../../components/ui/prompt-dialog.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';
import { ReviewCommentList } from './diff/ReviewComment.js';
import { DiffRowsView } from './diff/DiffRowsView.js';
import { type DiffRowHandlers } from './diff/DiffRow.js';
import { useDiffRows } from './diff/useDiffRows.js';
import { hunkExcerpt } from './diff/diff-format.js';
import type { SnapshotFileDiff, SnapshotHunkLine, SnapshotReviewComment } from './types.js';

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

  const { rows, fileLevelComments, maxContentChars } = useDiffRows(diff, comments);

  // Shows the prompt dialog, then forwards the comment. `fingerprint` resolves
  // back to the hunk object here (not threaded through every row) so the row
  // handlers stay referentially stable for `React.memo`.
  const runAddComment = useCallback(
    async (fingerprint: string | null, line?: SnapshotHunkLine) => {
      const hunk = fingerprint != null ? diff.hunks.find((h) => h.fingerprint === fingerprint) ?? null : null;
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
    },
    [diff.hunks, diff.baseline.id, diff.baseline.filePath, onAddComment, t],
  );

  const onAccept = useCallback(
    (fp: string) => { setLocalBusy(true); onAcceptHunk(fp).finally(() => setLocalBusy(false)); },
    [onAcceptHunk],
  );
  const onRevert = useCallback(
    (fp: string) => { setLocalBusy(true); onRevertHunk(fp).finally(() => setLocalBusy(false)); },
    [onRevertHunk],
  );
  const onCommentClick = useCallback(
    (fp: string, line?: SnapshotHunkLine) => { void runAddComment(fp, line); },
    [runAddComment],
  );

  const handlers: DiffRowHandlers = useMemo(
    () => ({ onCommentClick, onAccept, onRevert, onExpand: onExpandContext, onUpdateComment, busy: isBusy }),
    [onCommentClick, onAccept, onRevert, onExpandContext, onUpdateComment, isBusy],
  );

  const actions = (
    <div className="flex flex-shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={isBusy}
            onClick={() => void runAddComment(null)}
            className="h-7 w-7"
            aria-label={t('snapshotDiff.fileComment')}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('snapshotDiff.fileComment')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={isBusy}
            onClick={() => { setLocalBusy(true); onAutoReview().finally(() => setLocalBusy(false)); }}
            className="h-7 w-7"
            aria-label={t('snapshotDiff.autoReview')}
          >
            <Bot className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('snapshotDiff.autoReview')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={isBusy || !canSubmitReview}
            onClick={() => { setLocalBusy(true); onSubmitReview().finally(() => setLocalBusy(false)); }}
            className="h-7 w-7"
            aria-label={t('snapshotDiff.sendReview')}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('snapshotDiff.sendReview')}</TooltipContent>
      </Tooltip>
      <div className="mx-0.5 h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="default"
            disabled={isBusy}
            onClick={() => { setLocalBusy(true); onAcceptFile().finally(() => setLocalBusy(false)); }}
            className="h-7 w-7"
            aria-label={t('snapshotDiff.keepFile')}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('snapshotDiff.keepFile')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={isBusy}
            onClick={() => { setLocalBusy(true); onRevertFile().finally(() => setLocalBusy(false)); }}
            className="h-7 w-7"
            aria-label={t('snapshotDiff.revertFile')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('snapshotDiff.revertFile')}</TooltipContent>
      </Tooltip>
    </div>
  );

  const header = (
    <div className="flex min-h-10 items-center justify-between gap-2 border-b bg-card px-2.5 py-1.5">
      <div className="min-w-0 flex-1 truncate font-mono text-xs" title={diff.baseline.filePath}>
        {diff.baseline.filePath}
      </div>
      {actions}
    </div>
  );

  const fileComments = fileLevelComments.length > 0 && (
    <div className="border-b p-2 max-h-48 overflow-y-auto">
      <ReviewCommentList comments={fileLevelComments} onUpdate={onUpdateComment} busy={isBusy} />
    </div>
  );

  if (diff.diffDisabled || diff.hunks.length === 0) {
    const disabled = diff.diffDisabled;
    return (
      <div className="flex flex-col h-full min-h-0 min-w-0">
        {header}
        {fileComments}
        <div className="flex flex-col items-center justify-center h-full text-center p-6 gap-3 text-sm text-muted-foreground">
          {disabled ? (
            <>
              <span>{t('snapshotDiff.tooLarge')}</span>
              <span>{t('snapshotDiff.largeFileHint')}</span>
            </>
          ) : (
            <>
              <span>{t('snapshotDiff.noRemainingChanges', { file: diff.baseline.filePath })}</span>
              <span>{t('snapshotDiff.matchesBaseline')}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      {header}
      {fileComments}
      <DiffRowsView rows={rows} maxContentChars={maxContentChars} handlers={handlers} />
    </div>
  );
}
