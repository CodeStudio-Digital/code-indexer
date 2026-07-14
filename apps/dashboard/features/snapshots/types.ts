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
  oldLine?: number;
  newLine?: number;
}

export interface RoundSnapshotFileSummary extends SnapshotFileSummary {
  roundMessageId: number;
  roundSnapshotId: number;
  globalBaselineId: number;
  projectId: number | null;
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
  hiddenBefore: number;
  hiddenAfter: number;
  canExpandBefore: boolean;
  canExpandAfter: boolean;
  decision: HunkDecision;
}

export interface SnapshotFileDiff {
  baseline: {
    id: number;
    filePath: string;
    existedBefore: boolean;
    oversized: boolean;
    status: BaselineStatus;
    globalBaselineId?: number;
    roundMessageId?: number;
  };
  hunks: SnapshotHunk[];
  diffDisabled: boolean;
  currentContent: string | null;
}

export interface RoundSnapshotReviewFinding {
  id: number;
  round_snapshot_id: number;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: SnapshotReviewSeverity;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
}

export type SnapshotReviewSource = 'manual' | 'auto';
export type SnapshotReviewStatus = 'open' | 'accepted' | 'dismissed' | 'sent';
export type SnapshotReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | null;

export interface SnapshotReviewRun {
  id: number;
  session_kind: string;
  session_id: number;
  source: SnapshotReviewSource;
  status: 'running' | 'completed' | 'error';
  provider_id: string | null;
  model_id: string | null;
  raw_response: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface SnapshotReviewComment {
  id: number;
  run_id: number | null;
  baseline_id: number;
  source: SnapshotReviewSource;
  status: SnapshotReviewStatus;
  file_path: string;
  hunk_fingerprint: string | null;
  old_line: number | null;
  new_line: number | null;
  severity: SnapshotReviewSeverity;
  body: string;
  suggested_fix: string | null;
  diff_excerpt: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnapshotReviewsResponse {
  runs: SnapshotReviewRun[];
  comments: SnapshotReviewComment[];
}
