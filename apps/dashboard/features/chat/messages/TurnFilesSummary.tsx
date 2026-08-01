/**
 * Codex-style "files changed" block shown at the end of a completed turn. Lists
 * the turn's edited files (each expandable to its diff) with total +/- counts,
 * plus quick actions: Undo all (revert this turn's files), Review (auto-review),
 * and View snapshot (open the full panel). Derived from persisted tool calls, so
 * it stays put on scrollback.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FileEdit, Loader2, RotateCcw, ScanSearch } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import {
  fetchRoundSnapshotList,
  revertRoundAll,
  runRoundAutoReview,
} from '../../snapshots/api.js';
import { FileChangeRow } from './FileChangeRow.js';
import { useSnapshotActions, useSnapshotFiles } from './snapshot-files-context.js';
import { matchSnapshotPath } from './snapshot-path-match.js';
import type { EditFileRef } from './edit-tools.js';
import type {
  RoundSnapshotFileSummary,
  RoundSnapshotReviewFinding,
} from '../../snapshots/types.js';

export function TurnFilesSummary({
  paths,
  roundMessageId,
}: {
  paths: EditFileRef[];
  roundMessageId?: number;
}) {
  const { t } = useTranslation('chat');
  const confirm = useConfirm();
  const actions = useSnapshotActions();
  const byPath = useSnapshotFiles();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roundFiles, setRoundFiles] = useState<RoundSnapshotFileSummary[]>([]);
  const [reviews, setReviews] = useState<RoundSnapshotReviewFinding[]>([]);
  const [roundLoaded, setRoundLoaded] = useState(false);
  const [roundError, setRoundError] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const loadRound = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++loadRequestIdRef.current;
    if (!actions || actions.scope !== 'coder' || roundMessageId == null) {
      setRoundFiles([]);
      setReviews([]);
      setRoundError(null);
      setRoundLoaded(true);
      return;
    }
    try {
      const result = await fetchRoundSnapshotList(
        actions.scope,
        actions.sessionId,
        roundMessageId,
        signal,
      );
      if (signal?.aborted || requestId !== loadRequestIdRef.current) return;
      setRoundFiles(result.files);
      setReviews(result.reviews);
      setRoundError(null);
    } catch (error) {
      if (signal?.aborted || requestId !== loadRequestIdRef.current) return;
      setRoundFiles([]);
      setReviews([]);
      setRoundError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted && requestId === loadRequestIdRef.current) setRoundLoaded(true);
    }
  }, [actions, roundMessageId]);

  useEffect(() => {
    const controller = new AbortController();
    setRoundLoaded(false);
    void loadRound(controller.signal);
    return () => {
      controller.abort();
      loadRequestIdRef.current += 1;
    };
  }, [loadRound]);

  const { added, removed, globalBaselineIds } = useMemo(() => {
    let a = 0;
    let r = 0;
    const ids = new Set<string>();
    for (const snapshot of roundFiles) {
      a += snapshot.addedLines;
      r += snapshot.removedLines;
      ids.add(snapshot.globalBaselineId);
    }
    // Legacy rows have no round envelope, but the global modal must remain
    // reachable. Use the cumulative map only for that navigation target —
    // never for the round counts or inline diff.
    if (ids.size === 0) {
      for (const ref of paths) {
        const global = matchSnapshotPath(byPath, ref.path).file;
        if (global) ids.add(global.baselineId);
      }
    }
    return { added: a, removed: r, globalBaselineIds: [...ids] };
  }, [paths, byPath, roundFiles]);

  const displayEntries = useMemo(() => {
    if (roundFiles.length === 0) {
      return paths.map((ref) => ({ ref, snapshot: undefined }));
    }
    return roundFiles.map((snapshot) => {
      const existing = paths.find((ref) => ref.path === snapshot.filePath);
      const op: EditFileRef['op'] = !snapshot.existedBefore
        ? 'add'
        : snapshot.removedLines > 0 && snapshot.addedLines === 0
          ? 'delete'
          : 'edit';
      return { ref: existing ?? { path: snapshot.filePath, op }, snapshot };
    });
  }, [paths, roundFiles]);

  const activeRoundCount = roundFiles.filter((file) => file.status === 'active').length;
  const roundAvailable = roundMessageId != null && roundFiles.length > 0;

  if (paths.length === 0) return null;
  const showToolbar = !!actions && actions.showToolbar !== false;

  const undoAll = async () => {
    if (!actions || roundMessageId == null || activeRoundCount === 0) return;
    const ok = await confirm({
      title: t('messages.undoTurnTitle'),
      description: t('messages.undoTurnDescription', { count: activeRoundCount }),
      confirmLabel: t('messages.undoTurnConfirm'),
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await revertRoundAll(actions.scope, actions.sessionId, roundMessageId);
      if (!result.ok) {
        setRoundError(result.conflicts.map((conflict) => `${conflict.filePath}: ${conflict.reason}`).join('\n'));
        return;
      }
      actions.refresh();
      await loadRound();
    } catch (error) {
      setRoundError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!actions || roundMessageId == null || !roundAvailable) return;
    setBusy(true);
    try {
      const result = await runRoundAutoReview(actions.scope, actions.sessionId, roundMessageId);
      setReviews(result.reviews);
      setRoundError(null);
    } catch (error) {
      setRoundError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-card/35">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', open ? '' : '-rotate-90')} />
          <FileEdit className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-foreground/80 truncate">
            {t('messages.filesChanged', { count: displayEntries.length })}
          </span>
          <span className="shrink-0 tabular-nums text-[11px] flex items-center gap-1.5">
            {!roundLoaded ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : roundAvailable ? (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
                <span className="text-rose-600 dark:text-rose-400">−{removed}</span>
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </span>
        </button>
        {showToolbar && actions && (
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-1.5" disabled={busy || activeRoundCount === 0} onClick={undoAll}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              <span className="ml-1">{t('messages.undoAll')}</span>
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px] px-1.5" disabled={busy || !roundAvailable} onClick={review}>
              <ScanSearch className="h-3 w-3" />
              <span className="ml-1">{t('messages.reviewChanges')}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[11px] px-1.5"
              disabled={globalBaselineIds.length === 0}
              onClick={() => actions.openSnapshots(globalBaselineIds[0])}
            >
              {t('messages.viewSnapshot')}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="px-2 pb-2 space-y-1">
          {displayEntries.map(({ ref, snapshot }, index) => (
            <FileChangeRow
              key={snapshot?.roundSnapshotId ?? `${ref.path}:${ref.op}:${index}`}
              file={ref}
              snapshot={snapshot}
              roundMessageId={roundMessageId}
              reviewFindings={snapshot
                ? reviews.filter((finding) => finding.round_snapshot_id === snapshot.roundSnapshotId)
                : []}
              onRoundMutated={loadRound}
            />
          ))}
          {roundLoaded && !roundAvailable && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              {t('messages.roundSnapshotUnavailable')}
            </div>
          )}
          {roundError && (
            <div className="whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              {roundError}
            </div>
          )}
          {reviews.length > 0 && (
            <div className="space-y-1 rounded border border-border/60 bg-background/60 p-2">
              {reviews.map((finding) => {
                const file = roundFiles.find((item) => item.roundSnapshotId === finding.round_snapshot_id);
                return (
                  <div key={finding.id} className="text-[11px] text-foreground/80">
                    <span className="font-mono text-muted-foreground">{file?.filePath ?? 'snapshot'}</span>
                    {finding.severity && <span className="ml-1 uppercase text-amber-600">[{finding.severity}]</span>}
                    <span className="ml-1">{finding.body}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
