/**
 * Compact, self-contained diff for one file, embedded inline in a chat message.
 * Reuses `useDiffRows` + `DiffRowsView` (same rows as the full panel, incl.
 * per-hunk keep/revert) inside a bounded, scrollable box.
 */
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { useDiffRows } from './useDiffRows.js';
import { DiffRowsView } from './DiffRowsView.js';
import { useInlineFileDiff } from './useInlineFileDiff.js';
import { useSnapshotActions } from '../../chat/messages/snapshot-files-context.js';
import type { SessionScope, SnapshotFileDiff, SnapshotReviewComment } from '../types.js';

const NO_COMMENTS: SnapshotReviewComment[] = [];
const EMPTY_DIFF: SnapshotFileDiff = {
  baseline: { id: 0, filePath: '', existedBefore: true, oversized: false, status: 'active' },
  hunks: [],
  diffDisabled: false,
  currentContent: null,
};

export function InlineDiff({
  scope,
  sessionId,
  baselineId,
  refreshKey,
}: {
  scope: SessionScope;
  sessionId: number;
  baselineId: number;
  refreshKey?: string | number;
}) {
  const { t } = useTranslation('chat');
  const actions = useSnapshotActions();
  const { diff, loading, handlers } = useInlineFileDiff(scope, sessionId, baselineId, actions, refreshKey);
  const { rows, maxContentChars } = useDiffRows(diff ?? EMPTY_DIFF, NO_COMMENTS);

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
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => actions.openSnapshots(baselineId)}>
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
