import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSnapshotList } from '../../snapshots/api.js';
import type { SnapshotFileSummary } from '../../snapshots/types.js';
import { buildSnapshotFileMap, type SnapshotActions } from '../../chat/messages/snapshot-files-context.js';
export function useEditorSnapshotFiles(selectedId: string | null, snapshotInventoryTick: number) {
  const [snapshotFiles, setSnapshotFiles] = useState<Map<string, SnapshotFileSummary>>(new Map());
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0);

  const refreshSnapshots = useCallback(() => setSnapshotRefreshNonce((n) => n + 1), []);
  const snapshotActions = useMemo<SnapshotActions | null>(
    () => selectedId
      ? {
          scope: 'coder',
          sessionId: selectedId,
          openSnapshots: () => undefined,
          refresh: refreshSnapshots,
          showToolbar: false,
        }
      : null,
    [selectedId, refreshSnapshots],
  );

  useEffect(() => {
    if (!selectedId) {
      setSnapshotFiles(new Map());
      return;
    }
    let cancelled = false;
    fetchSnapshotList('coder', selectedId, {
      includeClosed: true,
      refreshKey: `${snapshotInventoryTick}:${snapshotRefreshNonce}`,
    })
      .then((r) => {
        if (!cancelled) setSnapshotFiles(buildSnapshotFileMap(r.files));
      })
      .catch(() => {
        if (!cancelled) setSnapshotFiles(new Map());
      });
    return () => {
      cancelled = true;
    };
  // Refresh once per completed edit tool (or explicit review action), not for
  // every file-write ping emitted by a multi-file edit.
  }, [selectedId, snapshotRefreshNonce, snapshotInventoryTick]);


  return { snapshotFiles, snapshotActions };
}
