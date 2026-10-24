import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { DB } from '@mcp/store/db/types.js';
import type { ContextSnapshot, DBFile, DBSymbol, ExportOptions, ExportSection } from '@mcp/shared/types.js';

export const EXPORT_SECTIONS: readonly ExportSection[] = ['overview', 'architecture', 'files', 'symbols', 'api', 'snapshots'];
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export type ExportFile = Pick<DBFile, 'path' | 'language' | 'line_count' | 'size' | 'content_hash'>;
export interface ExportData {
  project: ReturnType<CodeIndexDB['getProject']>;
  stats?: ReturnType<CodeIndexDB['getStats']>;
  files: ExportFile[];
  symbols: DBSymbol[];
  snapshots: ContextSnapshot[];
}

export function exportSections(options: ExportOptions): ExportSection[] {
  if (options.format !== 'markdown' && options.format !== 'json') throw new Error('Export format must be markdown or json');
  if (!Array.isArray(options.sections) || options.sections.some(section => !EXPORT_SECTIONS.includes(section))) {
    throw new Error('Invalid export sections');
  }
  return [...new Set(options.sections.length ? options.sections : EXPORT_SECTIONS)];
}

export function assertExportSize(bytes: number): void {
  if (bytes > EXPORT_MAX_BYTES) throw new Error('Export exceeds 32 MiB; select fewer sections. No export file was replaced.');
}

/** Bounded keyset reads release the JS thread between pages. A revision fence
 * rejects concurrent index changes rather than exporting a mixture of versions.
 * No SQLite transaction is kept open over an await on the shared connection. */
export async function readExportData(db: CodeIndexDB, options: ExportOptions,
  sections: readonly ExportSection[], signal?: AbortSignal): Promise<ExportData> {
  signal?.throwIfAborted();
  const index = db.projectScopedDb(options.projectId);
  const central = db.raw();
  const handles = [...new Set([index, central])];
  const revision = (handle: DB) => `${handle.pragma('data_version', { simple: true })}:${
    (handle.prepare('SELECT total_changes() AS n').get() as { n: number }).n}`;
  const revisions = handles.map(revision);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (db.projectScopedDb(options.projectId) !== index || db.raw() !== central
      || handles.some((handle, i) => revision(handle) !== revisions[i])) {
      throw new Error('Project index changed during export; retry after indexing settles. No export file was replaced.');
    }
  };
  const checkpoint = async () => { await yieldTurn(); assertCurrent(); };
  const data: ExportData = { project: db.getProject(options.projectId), files: [], symbols: [], snapshots: [] };
  if (!data.project) throw new Error('Project not found');
  let bytes = 0;
  const account = (rows: unknown[]) => {
    for (const row of rows) { bytes += Buffer.byteLength(JSON.stringify(row), 'utf8'); assertExportSize(bytes); }
  };
  if (sections.includes('overview')) { data.stats = db.getStats(options.projectId, { fresh: true }); await checkpoint(); }
  if (sections.includes('architecture') || sections.includes('files')) {
    let after: string | undefined;
    while (true) {
      assertCurrent();
      const rows = index.prepare(`SELECT path, language, line_count, size, content_hash FROM files
        WHERE project_id = ? ${after === undefined ? '' : 'AND path > ?'} ORDER BY path LIMIT 256`)
        .all(...(after === undefined ? [options.projectId] : [options.projectId, after])) as ExportFile[];
      account(rows); data.files.push(...rows);
      if (rows.length < 256) break;
      after = rows.at(-1)!.path; await checkpoint();
    }
    await checkpoint();
  }
  if (sections.includes('symbols') || sections.includes('api')) {
    let after: DBSymbol | undefined;
    while (true) {
      assertCurrent();
      const rows = index.prepare(`SELECT * FROM symbols WHERE project_id = ?
        ${after ? 'AND (name, id) > (?, ?)' : ''} ORDER BY name, id LIMIT 256`)
        .all(...(after ? [options.projectId, after.name, after.id] : [options.projectId])) as DBSymbol[];
      account(rows); data.symbols.push(...rows);
      if (rows.length < 256) break;
      after = rows.at(-1)!; await checkpoint();
    }
    await checkpoint();
  }
  if (sections.includes('snapshots') && options.includeSnapshots) {
    let after = 0;
    while (true) {
      assertCurrent();
      const rows = central.prepare(`SELECT * FROM snapshots WHERE project_id = ? AND archived_at IS NULL
        AND id > ? ORDER BY id LIMIT 256`).all(options.projectId, after) as ContextSnapshot[];
      account(rows); data.snapshots.push(...rows);
      if (rows.length < 256) break;
      after = rows.at(-1)!.id; await checkpoint();
    }
    await checkpoint();
  }
  assertCurrent();
  return data;
}
