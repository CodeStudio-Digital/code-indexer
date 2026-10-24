/**
 * Single-file diff controller for the inline chat diff: fetches one baseline's
 * diff and provides `DiffRowHandlers` wired to the snapshot API (per-hunk
 * keep/revert + context expand). Review-commenting is delegated to the full
 * panel (`onCommentClick` opens it), so the inline widget stays lean.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptHunk,
  acceptRoundHunk,
  fetchFileDiff,
  fetchRoundFileDiff,
  revertHunk,
  revertRoundHunk,
} from '../api.js';
import type { SessionScope, SnapshotFileDiff, ToolSnapshotFileSummary } from '../types.js';
import { fetchToolFileDiff } from '../tool-api.js';
import type { DiffRowHandlers } from './DiffRow.js';
import type { SnapshotActions } from '../../chat/messages/snapshot-files-context.js';

interface Result {
  diff: SnapshotFileDiff | null;
  loading: boolean;
  handlers: DiffRowHandlers;
}

export function useInlineFileDiff(
  scope: SessionScope,
  sessionId: string,
  baselineId: string,
  actions: SnapshotActions | null,
  /** Bumping value (e.g. the file's `lastEditedAt`) that forces a refetch. */
  refreshKey: string | number | undefined,
  roundMessageId?: number,
  globalBaselineId?: string,
  onMutated?: () => void,
  toolSnapshot?: Pick<ToolSnapshotFileSummary, 'toolUseId' | 'fileIndex'>,
): Result {
  const [diff, setDiff] = useState<SnapshotFileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ctxBefore, setCtxBefore] = useState(3);
  const [ctxAfter, setCtxAfter] = useState(3);
  const token = useRef(0);
  const toolUseId = toolSnapshot?.toolUseId;
  const fileIndex = toolSnapshot?.fileIndex;

  const load = useCallback(async () => {
    const t = ++token.current;
    setLoading(true);
    try {
      const options = { context: 3, contextBefore: ctxBefore, contextAfter: ctxAfter };
      const r = toolUseId != null && fileIndex != null
        ? await fetchToolFileDiff(scope, sessionId, toolUseId, fileIndex, ctxBefore, ctxAfter)
        : roundMessageId == null
        ? await fetchFileDiff(scope, sessionId, baselineId, options)
        : await fetchRoundFileDiff(scope, sessionId, roundMessageId, baselineId, options);
      if (t === token.current) setDiff(r);
    } catch {
      if (t === token.current) setDiff(null);
    } finally {
      if (t === token.current) setLoading(false);
    }
  }, [scope, sessionId, baselineId, roundMessageId, toolUseId, fileIndex, ctxBefore, ctxAfter]);

  useEffect(() => {
    void load();
    return () => { token.current++; };
  }, [load, refreshKey]);

  const mutate = useCallback(
    (fn: () => Promise<unknown>) => {
      if (toolUseId != null) return;
      setBusy(true);
      void fn()
        .catch(() => {})
        .finally(() => {
          setBusy(false);
          void load();
          actions?.refresh();
          onMutated?.();
        });
    },
    [load, actions, onMutated, toolUseId],
  );

  const handlers = useMemo<DiffRowHandlers>(
    () => ({
      onAccept: (fp) => mutate(() => roundMessageId == null
        ? acceptHunk(scope, sessionId, baselineId, fp)
        : acceptRoundHunk(scope, sessionId, roundMessageId, baselineId, fp)),
      onRevert: (fp) => mutate(() => roundMessageId == null
        ? revertHunk(scope, sessionId, baselineId, fp)
        : revertRoundHunk(scope, sessionId, roundMessageId, baselineId, fp)),
      onExpand: (side) =>
        side === 'before' ? setCtxBefore((v) => v + 10) : setCtxAfter((v) => v + 10),
      onCommentClick: () => actions?.openSnapshots(globalBaselineId ?? baselineId),
      onUpdateComment: () => {},
      busy,
      readOnly: toolUseId != null,
    }),
    [mutate, scope, sessionId, baselineId, roundMessageId, globalBaselineId, actions, busy, toolUseId],
  );

  return { diff, loading, handlers };
}
