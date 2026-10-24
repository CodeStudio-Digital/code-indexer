import type { ToolSnapshotRow } from './session-snapshot-port.js';
import type { FileDiff, FileSummary } from './session-snapshots.js';
import { computeHunks, type ComputeHunksOptions } from './snapshot-hunks.js';

/** Only persisted invocation contents participate; never consult the working tree. */
export function toolSnapshotDiff(row: ToolSnapshotRow, options: ComputeHunksOptions = {}): FileDiff {
  const context = (value: number | undefined) => Math.max(0, Math.min(1000, Number.isFinite(value) ? Math.floor(value!) : 3));
  const hunks = row.oversized ? [] : computeHunks(row.content_before ?? '', row.content_after ?? '', {
    context: context(options.context),
    contextBefore: context(options.contextBefore ?? options.context),
    contextAfter: context(options.contextAfter ?? options.context),
  });
  return {
    baseline: { id: row.global_baseline_id, filePath: row.file_path,
      existedBefore: row.existed_before, oversized: row.oversized, status: 'active' },
    hunks: hunks.map(hunk => ({ ...hunk, decision: 'pending' })),
    diffDisabled: row.oversized,
    currentContent: row.oversized ? null : row.content_after,
  };
}

export function toolSnapshotSummary(row: ToolSnapshotRow, fileIndex: number): FileSummary & {
  toolUseId: string; fileIndex: number; existedAfter: boolean; projectId: number | null;
} {
  const { hunks } = toolSnapshotDiff(row, { context: 0 });
  return {
    baselineId: row.global_baseline_id, filePath: row.file_path, status: 'active',
    existedBefore: row.existed_before, existedAfter: row.existed_after, oversized: row.oversized,
    firstSeenAt: row.first_seen_at, lastEditedAt: row.last_edited_at, closedAt: null,
    hunkCount: hunks.length, pendingHunks: hunks.length,
    addedLines: hunks.reduce((sum, hunk) => sum + hunk.addedCount, 0),
    removedLines: hunks.reduce((sum, hunk) => sum + hunk.removedCount, 0),
    resolved: !row.oversized && hunks.length === 0,
    toolUseId: row.tool_use_id, fileIndex, projectId: row.project_id ?? null,
  };
}
