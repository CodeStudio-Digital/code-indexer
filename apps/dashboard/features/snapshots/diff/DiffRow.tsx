/**
 * Renders one flattened `DiffRow`. Memoized so that — within the small window
 * the virtualizer keeps mounted — only rows whose props actually change
 * re-render. All callbacks arrive via a stable `handlers` bag from the viewer;
 * the only churny input is `handlers.busy`, which is intentional (it disables
 * controls during an in-flight accept/revert).
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { lineLabel } from './diff-format.js';
import { InlineReviewComment, type OnUpdateComment } from './ReviewComment.js';
import type { DiffRow as DiffRowModel } from './useDiffRows.js';
import type { SnapshotHunkLine } from '../types.js';

export interface DiffRowHandlers {
  onCommentClick: (fingerprint: string, line?: SnapshotHunkLine) => void;
  onAccept: (fingerprint: string) => void;
  onRevert: (fingerprint: string) => void;
  onExpand: (side: 'before' | 'after') => void;
  onUpdateComment: OnUpdateComment;
  busy: boolean;
  readOnly?: boolean;
}

function DiffRowImpl({ row, handlers }: { row: DiffRowModel; handlers: DiffRowHandlers }) {
  const { t } = useTranslation('projects');
  const { busy } = handlers;

  switch (row.kind) {
    case 'hunk-header': {
      const h = row.hunk;
      return (
        <div className={cn('flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/40 border-y text-[11px]', row.decided && 'opacity-60')}>
          <span className="text-muted-foreground">
            @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-emerald-700 dark:text-emerald-400">+{h.addedCount}</span>
            <span className="text-rose-700 dark:text-rose-400">-{h.removedCount}</span>
            {!handlers.readOnly && <Button size="icon" variant="ghost" className="h-6 w-6" disabled={busy} onClick={() => handlers.onCommentClick(h.fingerprint)} title={t('snapshotDiff.commentHunk')}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </Button>}
            {h.decision === 'kept' && <Badge variant="outline" className="text-[9px]">{t('snapshotDiff.kept')}</Badge>}
            {h.decision === 'reverted' && <Badge variant="outline" className="text-[9px]">{t('snapshotDiff.reverted')}</Badge>}
          </div>
        </div>
      );
    }
    case 'comment':
      return (
        <div className={cn(row.decided && 'opacity-60')}>
          <InlineReviewComment comment={row.comment} onUpdate={handlers.onUpdateComment} busy={busy} />
        </div>
      );
    case 'expand':
      return (
        <button
          type="button"
          onClick={() => handlers.onExpand(row.side)}
          className={cn('block w-full text-left px-3 py-1 text-[11px] text-muted-foreground bg-muted/20 hover:bg-muted/40', row.decided && 'opacity-60')}
        >
          {row.side === 'before'
            ? t('snapshotDiff.showLinesAbove', { count: row.hunk.hiddenBefore })
            : t('snapshotDiff.showLinesBelow', { count: row.hunk.hiddenAfter })}
        </button>
      );
    case 'line': {
      const line = row.line;
      const bg =
        line.type === 'add'
          ? 'bg-emerald-500/10 dark:bg-emerald-500/15'
          : line.type === 'remove'
            ? 'bg-rose-500/10 dark:bg-rose-500/15'
            : '';
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      return (
        <div className={cn('group flex items-start min-w-full px-3 whitespace-pre', bg, row.decided && 'opacity-60')}>
          <span className="select-none text-muted-foreground w-12 text-right pr-2 flex-none">{lineLabel(line)}</span>
          <span className="select-none text-muted-foreground w-3 flex-none">{prefix}</span>
          <span className="pr-8">{line.content || ' '}</span>
          {!handlers.readOnly && <button
            type="button"
            disabled={busy}
            onClick={() => handlers.onCommentClick(row.hunk.fingerprint, line)}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-1 flex-none"
            title={t('snapshotDiff.commentLine')}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </button>}
        </div>
      );
    }
    case 'footer':
      if (handlers.readOnly) return null;
      return (
        <div className="flex items-center justify-end gap-1 px-3 py-1.5 bg-muted/20 border-y">
          <Button size="sm" variant="ghost" onClick={() => handlers.onAccept(row.hunk.fingerprint)} disabled={busy} className="h-7 text-xs">
            {t('snapshotDiff.keepHunk')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => handlers.onRevert(row.hunk.fingerprint)} disabled={busy} className="h-7 text-xs">
            {t('snapshotDiff.undoHunk')}
          </Button>
        </div>
      );
  }
}

export const DiffRow = memo(DiffRowImpl);
