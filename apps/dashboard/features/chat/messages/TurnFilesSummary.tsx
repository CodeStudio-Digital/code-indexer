/**
 * Codex-style "files changed" block shown at the end of a completed turn. Lists
 * the turn's edited files (each expandable to its diff) with total +/- counts,
 * plus quick actions: Undo all (revert this turn's files), Review (auto-review),
 * and View snapshot (open the full panel). Derived from persisted tool calls, so
 * it stays put on scrollback.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FileEdit, Loader2, RotateCcw, ScanSearch } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import { revertFile, runAutoReview } from '../../snapshots/api.js';
import { FileChangeRow } from './FileChangeRow.js';
import { useSnapshotActions, useSnapshotFiles } from './snapshot-files-context.js';
import type { EditFileRef } from './edit-tools.js';

export function TurnFilesSummary({ paths }: { paths: EditFileRef[] }) {
  const { t } = useTranslation('chat');
  const confirm = useConfirm();
  const actions = useSnapshotActions();
  const byPath = useSnapshotFiles();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const { added, removed, baselineIds } = useMemo(() => {
    let a = 0;
    let r = 0;
    const ids: number[] = [];
    for (const p of paths) {
      const s = byPath.get(p.path);
      if (!s) continue;
      a += s.addedLines;
      r += s.removedLines;
      if (s.status === 'active') ids.push(s.baselineId);
    }
    return { added: a, removed: r, baselineIds: ids };
  }, [paths, byPath]);

  if (paths.length === 0) return null;
  const showToolbar = !!actions && actions.showToolbar !== false;

  const undoAll = async () => {
    if (!actions || baselineIds.length === 0) return;
    const ok = await confirm({
      title: t('messages.undoTurnTitle'),
      description: t('messages.undoTurnDescription', { count: baselineIds.length }),
      confirmLabel: t('messages.undoTurnConfirm'),
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      for (const id of baselineIds) {
        await revertFile(actions.scope, actions.sessionId, id).catch(() => {});
      }
      actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!actions) return;
    setBusy(true);
    try {
      await runAutoReview(actions.scope, actions.sessionId).catch(() => {});
      actions.openSnapshots(baselineIds[0]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3 my-2 rounded-lg border border-border/70 bg-muted/25 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', open ? '' : '-rotate-90')} />
          <FileEdit className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground/80 truncate">
            {t('messages.filesChanged', { count: paths.length })}
          </span>
          <span className="shrink-0 tabular-nums text-[11px] flex items-center gap-1.5">
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
            <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
          </span>
        </button>
        {showToolbar && actions && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-1.5" disabled={busy || baselineIds.length === 0} onClick={undoAll}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              <span className="ml-1">{t('messages.undoAll')}</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-1.5" disabled={busy} onClick={review}>
              <ScanSearch className="h-3 w-3" />
              <span className="ml-1">{t('messages.reviewChanges')}</span>
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px] px-1.5" onClick={() => actions.openSnapshots(baselineIds[0])}>
              {t('messages.viewSnapshot')}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {paths.map((ref) => (
            <FileChangeRow key={`${ref.path}:${ref.op}`} file={ref} />
          ))}
        </div>
      )}
    </div>
  );
}
