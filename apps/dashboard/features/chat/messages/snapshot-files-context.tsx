/**
 * Shares the session's snapshot file list (added/removed counts + baselineId per
 * path) and the "open snapshot panel" action with the chat's file-edit blocks.
 *
 * Two SEPARATE contexts on purpose: the actions object is stable and the file
 * map churns on every `session_snapshot_changed` ping. Splitting them means a
 * ping re-renders only the file/summary blocks that read the map, never the
 * consumers that only need the (stable) actions.
 */
import React, { createContext, useContext } from 'react';
import type { SessionScope, SnapshotFileSummary } from '../../snapshots/types.js';

export interface SnapshotActions {
  scope: SessionScope;
  sessionId: number;
  /** Open the full Session Snapshots panel, optionally preselecting a file. */
  openSnapshots: (baselineId?: number) => void;
  /** Re-fetch the snapshot list after a user action (keep/revert) that the
   *  agent-driven `snapshotTick` won't cover. */
  refresh: () => void;
  /** Compact rails can still expand inline diffs without showing the full
   *  snapshot review toolbar in every turn summary. */
  showToolbar?: boolean;
}

const ActionsContext = createContext<SnapshotActions | null>(null);
const EMPTY: Map<string, SnapshotFileSummary> = new Map();
const FilesContext = createContext<Map<string, SnapshotFileSummary>>(EMPTY);

export function SnapshotFilesProvider({
  actions,
  files,
  children,
}: {
  actions: SnapshotActions | null;
  files: Map<string, SnapshotFileSummary>;
  children: React.ReactNode;
}) {
  return (
    <ActionsContext.Provider value={actions}>
      <FilesContext.Provider value={files}>{children}</FilesContext.Provider>
    </ActionsContext.Provider>
  );
}

export function useSnapshotActions(): SnapshotActions | null {
  return useContext(ActionsContext);
}

export function useSnapshotFiles(): Map<string, SnapshotFileSummary> {
  return useContext(FilesContext);
}

export function useSnapshotFile(path: string): SnapshotFileSummary | undefined {
  return useContext(FilesContext).get(path);
}

/** A/M/D badge kind — mirrors `SnapshotFileList.statusKind`. */
export function statusKind(f: SnapshotFileSummary): 'A' | 'M' | 'D' {
  if (!f.existedBefore) return 'A';
  if (f.removedLines > 0 && f.addedLines === 0 && f.pendingHunks > 0) return 'D';
  return 'M';
}

/**
 * Collapse a raw snapshot list into a by-path map. A file edited → kept/reverted
 * → edited again yields two baselines with the same path; prefer the `active`
 * one, else the most recently edited.
 */
export function buildSnapshotFileMap(
  files: SnapshotFileSummary[],
): Map<string, SnapshotFileSummary> {
  const m = new Map<string, SnapshotFileSummary>();
  for (const f of files) {
    const cur = m.get(f.filePath);
    if (!cur) {
      m.set(f.filePath, f);
      continue;
    }
    if (f.status === 'active' && cur.status !== 'active') m.set(f.filePath, f);
    else if (cur.status === 'active' && f.status !== 'active') { /* keep cur */ }
    else if (f.lastEditedAt > cur.lastEditedAt) m.set(f.filePath, f);
  }
  return m;
}
