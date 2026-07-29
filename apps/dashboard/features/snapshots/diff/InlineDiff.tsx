/**
 * Compact, self-contained diff for one file, embedded inline in a chat message.
 * Reuses `useDiffRows` + `DiffRowsView` (same rows as the full panel, incl.
 * per-hunk keep/revert) inside a bounded, scrollable box.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { useDiffRows } from './useDiffRows.js';
import { DiffRowsView } from './DiffRowsView.js';
import { useInlineFileDiff } from './useInlineFileDiff.js';
import { useSnapshotActions } from '../../chat/messages/snapshot-files-context.js';
import type {
  RoundSnapshotReviewFinding,
  SessionScope,
  SnapshotFileDiff,
  SnapshotReviewComment,
} from '../types.js';

const NO_COMMENTS: SnapshotReviewComment[] = [];
const EMPTY_DIFF: SnapshotFileDiff = {
  baseline: { id: '', filePath: '', existedBefore: true, oversized: false, status: 'active' },
  hunks: [],
  diffDisabled: false,
  currentContent: null,
};

export function InlineDiff({
  scope,
  sessionId,
  baselineId,
  roundMessageId,
  globalBaselineId,
  reviewFindings = [],
  onMutated,
  refreshKey,
}: {
  scope: SessionScope;
  sessionId: string;
  baselineId: string;
  roundMessageId?: number;
  globalBaselineId?: string;
  reviewFindings?: RoundSnapshotReviewFinding[];
  onMutated?: () => void;
  refreshKey?: string | number;
}) {
  const { t } = useTranslation('chat');
  const actions = useSnapshotActions();
  const { diff, loading, handlers } = useInlineFileDiff(
    scope,
    sessionId,
    baselineId,
    actions,
    refreshKey,
    roundMessageId,
    globalBaselineId,
    onMutated,
  );
  const contextualComments = useMemo<SnapshotReviewComment[]>(
    () => reviewFindings.map((finding) => ({
      id: finding.id,
      run_id: null,
      baseline_id: baselineId,
      source: 'auto',
      status: 'accepted',
      file_path: '',
      hunk_fingerprint: finding.hunk_fingerprint,
      old_line: finding.old_line,
      new_line: finding.new_line,
      severity: finding.severity,
      body: finding.body,
      suggested_fix: finding.suggested_fix,
      diff_excerpt: finding.diff_excerpt,
      created_at: finding.created_at,
      updated_at: finding.created_at,
    })),
    [reviewFindings, baselineId],
  );
  const { rows, maxContentChars } = useDiffRows(
    diff ?? EMPTY_DIFF,
    contextualComments.length > 0 ? contextualComments : NO_COMMENTS,
  );

  if (loading && !diff) {
    return (
      <div className="mt-1 flex items-center gap-2 px-2 py-3 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('messages.loadingDiff', { defaultValue: 'Loading diff…' })}
      </div>
    );
  }

  if (!diff || diff.diffDisabled || rows.length === 0) {
    const tooLarge = diff?.diffDisabled;
    return (
      <div className="mt-1 flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
        <span>
          {tooLarge
            ? t('messages.fileTooLargeOpenSnapshot')
            : t('messages.noRemainingChanges')}
        </span>
        {actions && actions.showToolbar !== false && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[11px]"
            onClick={() => actions.openSnapshots(globalBaselineId ?? baselineId)}
          >
            {t('messages.viewSnapshot')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-col max-h-[45vh] min-h-[5rem] rounded-md border overflow-hidden">
      <DiffRowsView rows={rows} maxContentChars={maxContentChars} handlers={handlers} />
    </div>
  );
}
