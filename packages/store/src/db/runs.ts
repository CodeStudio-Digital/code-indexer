import type { IndexRun, RunStatus } from '@mcp/shared/types.js';
import type { DB } from './types.js';

export interface FinishRunData {
  status: RunStatus;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  errorCount: number;
  phaseTimings?: {
    scanMs: number;
    parseMs: number;
    writeMs: number;
    sweepMs: number;
  };
  peakRssMb?: number;
}

export function start(db: DB, projectId: number): number {
  const result = db.prepare('INSERT INTO runs (project_id) VALUES (?)').run(projectId);
  return result.lastInsertRowid as number;
}

export function finish(db: DB, runId: number, data: FinishRunData): void {
  db.prepare(`
    UPDATE runs SET
      finished_at = datetime('now'), status = ?,
      total_files = ?, indexed_files = ?, skipped_files = ?, error_count = ?,
      phase_timings_json = ?, peak_rss_mb = ?
    WHERE id = ?
  `).run(
    data.status, data.totalFiles, data.indexedFiles, data.skippedFiles, data.errorCount,
    data.phaseTimings
      ? JSON.stringify({
          scan_ms: data.phaseTimings.scanMs,
          parse_ms: data.phaseTimings.parseMs,
          write_ms: data.phaseTimings.writeMs,
          sweep_ms: data.phaseTimings.sweepMs,
        })
      : null,
    data.peakRssMb ?? null,
    runId
  );
}

export function get(db: DB, id: number): IndexRun | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as IndexRun | undefined;
}

export function list(db: DB, projectId: number, limit: number = 20): IndexRun[] {
  return db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(projectId, limit) as IndexRun[];
}
