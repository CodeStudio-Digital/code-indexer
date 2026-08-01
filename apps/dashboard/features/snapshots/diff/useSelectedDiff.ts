/**
 * Owns the lifecycle of the currently-selected file's diff: the authoritative
 * (user-initiated) load when the selection changes, plus the live refetch that
 * reacts to `session_snapshot_changed` pings while the agent edits.
 *
 * The live refetch is debounced (trailing 750ms) and guarded by a request
 * token + a selection mirror, so a burst of edits collapses into one
 * list+diff refresh and a late result can never overwrite a newer selection.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFileDiff } from '../api.js';
import type { SessionScope, SnapshotFileDiff } from '../types.js';

interface Options {
  scope: SessionScope;
  sessionId: string;
  selectedBaselineId: string | null;
  contextBefore: number;
  contextAfter: number;
  /** Bumping value mirroring live `session_snapshot_changed` SSE pings. */
  refreshKey: number | undefined;
  onReload: () => void;
  onReloadReviews: () => void;
  onError: (message: string) => void;
}

interface Result {
  diff: SnapshotFileDiff | null;
  diffLoading: boolean;
  /** Authoritative reload of one file's diff (e.g. after keep/undo hunk). */
  reloadDiff: (baselineId: string) => Promise<void>;
}

export function useSelectedDiff({
  scope,
  sessionId,
  selectedBaselineId,
  contextBefore,
  contextAfter,
  refreshKey,
  onReload,
  onReloadReviews,
  onError,
}: Options): Result {
  const [diff, setDiff] = useState<SnapshotFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const token = useRef(0);
  const lastRefreshKey = useRef<number | undefined>(refreshKey);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef(selectedBaselineId);
  selectedRef.current = selectedBaselineId;

  const reloadDiff = useCallback(
    async (baselineId: string) => {
      token.current++; // cancel any in-flight live refetch
      setDiffLoading(true);
      try {
        const r = await fetchFileDiff(scope, sessionId, baselineId, { context: 3, contextBefore, contextAfter });
        setDiff(r);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setDiffLoading(false);
      }
    },
    [scope, sessionId, contextBefore, contextAfter, onError],
  );

  // Load (or clear) the diff whenever the selection changes.
  useEffect(() => {
    if (selectedBaselineId == null) {
      setDiff(null);
      return;
    }
    void reloadDiff(selectedBaselineId);
  }, [selectedBaselineId, reloadDiff]);

  // Live pings: debounce the complete refresh. The list is not intrinsically
  // cheap: it verifies persisted baselines and computes current-file diffs.
  useEffect(() => {
    if (refreshKey === undefined) return;
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    const baselineId = selectedBaselineId;
    const reqToken = ++token.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (reqToken !== token.current) return; // superseded before firing
      onReload();
      onReloadReviews();
      if (baselineId == null) return;
      void fetchFileDiff(scope, sessionId, baselineId, { context: 3, contextBefore, contextAfter })
        .then((d) => {
          if (reqToken !== token.current || selectedRef.current !== baselineId) return;
          setDiff(d);
        })
        .catch(() => { /* swallow — UI shows stale */ });
    }, 750);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [refreshKey, scope, sessionId, selectedBaselineId, contextBefore, contextAfter, onReload, onReloadReviews]);

  return { diff, diffLoading, reloadDiff };
}
