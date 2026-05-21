/**
 * Wire shapes for the Session Snapshot UI. Mirrors what
 * `SessionSnapshotService.listFiles()` / `.getDiff()` return on the server.
 */

export type BaselineStatus = 'active' | 'closed_kept' | 'closed_reverted';
export type HunkDecision = 'pending' | 'kept' | 'reverted';
export type SessionScope = 'coder' | 'company';

export interface SnapshotFileSummary {
  baselineId: number;
  filePath: string;
  status: BaselineStatus;
  existedBefore: boolean;
  oversized: boolean;
  firstSeenAt: string;
  lastEditedAt: string;
  closedAt: string | null;
  hunkCount: number;
  pendingHunks: number;
  addedLines: number;
  removedLines: number;
  resolved: boolean;
  /** Set by the company-scope route. `null` for coder-scope. */
  projectId?: number | null;
  projectName?: string | null;
}

export interface SnapshotHunkLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

export interface SnapshotHunk {
  fingerprint: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: SnapshotHunkLine[];
  addedCount: number;
  removedCount: number;
  decision: HunkDecision;
}

export interface SnapshotFileDiff {
  baseline: {
    id: number;
    filePath: string;
    existedBefore: boolean;
    oversized: boolean;
    status: BaselineStatus;
  };
  hunks: SnapshotHunk[];
  diffDisabled: boolean;
  currentContent: string | null;
}
