/**
 * Single-file diff controller for the inline chat diff: fetches one baseline's
 * diff and provides `DiffRowHandlers` wired to the snapshot API (per-hunk
 * keep/revert + context expand). Review-commenting is delegated to the full
 * panel (`onCommentClick` opens it), so the inline widget stays lean.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acceptHunk, fetchFileDiff, revertHunk } from '../api.js';
import type { SessionScope, SnapshotFileDiff } from '../types.js';
import type { DiffRowHandlers } from './DiffRow.js';
import type { SnapshotActions } from '../../chat/messages/snapshot-files-context.js';

interface Result {
  diff: SnapshotFileDiff | null;
  loading: boolean;
  handlers: DiffRowHandlers;
}

export function useInlineFileDiff(
  scope: SessionScope,
  sessionId: number,
  baselineId: number,
  actions: SnapshotActions | null,
  /** Bumping value (e.g. the file's `lastEditedAt`) that forces a refetch. */
  refreshKey: string | number | undefined,
): Result {
  const [diff, setDiff] = useState<SnapshotFileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ctxBefore, setCtxBefore] = useState(3);
  const [ctxAfter, setCtxAfter] = useState(3);
  const token = useRef(0);

  const load = useCallback(async () => {
    const t = ++token.current;
    setLoading(true);
    try {
      const r = await fetchFileDiff(scope, sessionId, baselineId, {
        context: 3,
        contextBefore: ctxBefore,
        contextAfter: ctxAfter,
      });
      if (t === token.current) setDiff(r);
    } catch {
      if (t === token.current) setDiff(null);
    } finally {
      if (t === token.current) setLoading(false);
    }
  }, [scope, sessionId, baselineId, ctxBefore, ctxAfter]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const mutate = useCallback(
    (fn: () => Promise<unknown>) => {
      setBusy(true);
      void fn()
        .catch(() => {})
        .finally(() => {
          setBusy(false);
          void load();
          actions?.refresh();
        });
    },
    [load, actions],
  );

  const handlers = useMemo<DiffRowHandlers>(
    () => ({
      onAccept: (fp) => mutate(() => acceptHunk(scope, sessionId, baselineId, fp)),
      onRevert: (fp) => mutate(() => revertHunk(scope, sessionId, baselineId, fp)),
      onExpand: (side) =>
        side === 'before' ? setCtxBefore((v) => v + 10) : setCtxAfter((v) => v + 10),
      onCommentClick: () => actions?.openSnapshots(baselineId),
      onUpdateComment: () => {},
      busy,
    }),
    [mutate, scope, sessionId, baselineId, actions, busy],
  );

  return { diff, loading, handlers };
}
