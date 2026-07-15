/**
 * One file row shared by `FileEditBlock` and `TurnFilesSummary`: A/M/D badge +
 * path + `+added/−removed` + a chevron that expands the inline diff.
 * Completed-round callers pass the immutable round snapshot; live/tool rows
 * use the current session baseline until that frozen envelope is available.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { InlineDiff } from '../../snapshots/diff/InlineDiff.js';
import { useSnapshotActions, useSnapshotFile, statusKind } from './snapshot-files-context.js';
import type { EditFileRef, FileEditOp } from './edit-tools.js';
import type {
  RoundSnapshotFileSummary,
  RoundSnapshotReviewFinding,
} from '../../snapshots/types.js';

const STATUS_STYLES: Record<'A' | 'M' | 'D', string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  M: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  D: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};

function opToKind(op: FileEditOp): 'A' | 'M' | 'D' {
  if (op === 'add') return 'A';
  if (op === 'delete') return 'D';
  return 'M';
}

export function FileChangeRow({
  file,
  snapshot,
  roundMessageId,
  reviewFindings = [],
  onRoundMutated,
}: {
  file: EditFileRef;
  snapshot?: RoundSnapshotFileSummary;
  roundMessageId?: number;
  reviewFindings?: RoundSnapshotReviewFinding[];
  onRoundMutated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = useSnapshotActions();
  // A completed turn supplies its immutable round snapshot. Individual edit
  // cards do not have that envelope yet, so keep them useful with the live
  // session baseline instead of rendering permanent `--` placeholders.
  const globalSummary = useSnapshotFile(file.path);
  const summary = snapshot ?? globalSummary;

  const kind = summary ? statusKind(summary) : opToKind(file.op);
  const baselineId = summary?.baselineId;
  const canExpand = baselineId != null && actions != null;

  return (
    <div className="rounded-md border border-border/60 bg-card/40 overflow-hidden">
      <button
        type="button"
        onClick={() => canExpand && setOpen((o) => !o)}
        disabled={!canExpand}
        className={cn(
          'w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors',
          canExpand ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-default',
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform',
            open && 'rotate-90',
            !canExpand && 'opacity-0',
          )}
        />
        <span className={cn('rounded px-1 text-[10px] font-semibold leading-4 shrink-0', STATUS_STYLES[kind])}>
          {kind}
        </span>
        <span className="font-mono text-[11px] text-foreground/85 truncate min-w-0 flex-1">{file.path}</span>
        <span className="ml-auto shrink-0 tabular-nums text-[11px] flex items-center gap-1.5">
          <span className="text-emerald-600 dark:text-emerald-400">
            {summary ? `+${summary.addedLines}` : '–'}
          </span>
          <span className="text-rose-600 dark:text-rose-400">
            {summary ? `−${summary.removedLines}` : '–'}
          </span>
        </span>
      </button>
      {open && canExpand && (
        <div className="px-2 pb-2">
          <InlineDiff
            scope={actions.scope}
            sessionId={actions.sessionId}
            baselineId={baselineId}
            roundMessageId={snapshot ? (roundMessageId ?? snapshot.roundMessageId) : undefined}
            globalBaselineId={snapshot?.globalBaselineId}
            reviewFindings={reviewFindings}
            onMutated={onRoundMutated}
            refreshKey={summary?.lastEditedAt}
          />
        </div>
      )}
    </div>
  );
}
