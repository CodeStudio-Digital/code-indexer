import {
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, tableColumns, tableExists } from './db.js';

export interface MissingProjectCatalogEvidence {
  project_id: number;
  root_path: string;
  local_db_path: string;
  project_name?: string;
  root_exists: boolean;
}

/**
 * Read-only evidence collection for a central-catalog gap. Local project DBs
 * are never used as a fallback source of authority: finding a row here only
 * makes the mandatory re-registration action actionable.
 */
export function findMissingProjectCatalogEvidence(
  dataDir: string,
  projectId: number,
): MissingProjectCatalogEvidence[] {
  const projectsRoot = join(resolve(dataDir), 'projects');
  if (!existsSync(projectsRoot)) return [];
  const rootStat = lstatSync(projectsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];

  const evidence: MissingProjectCatalogEvidence[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const rootPath = join(projectsRoot, entry.name);
    const localDbPath = join(rootPath, '.mcp-indexer', 'index.db');
    if (!existsSync(localDbPath)) continue;
    const dbStat = lstatSync(localDbPath);
    if (!dbStat.isFile() || dbStat.isSymbolicLink()) continue;

    let db: ReturnType<typeof openDatabase> | null = null;
    try {
      db = openDatabase(localDbPath, { readonly: true, fileMustExist: true });
      if (!tableExists(db, 'projects')) continue;
      const columns = new Set(tableColumns(db, 'projects'));
      if (!columns.has('id') || !columns.has('root_path')) continue;
      const nameSelect = columns.has('name') ? ', name' : '';
      const row = db.prepare(
        `SELECT id, root_path${nameSelect} FROM projects WHERE id = ?`,
      ).get(projectId) as {
        id: number;
        root_path: string;
        name?: string | null;
      } | undefined;
      if (!row || Number(row.id) !== projectId || typeof row.root_path !== 'string') continue;
      evidence.push({
        project_id: projectId,
        root_path: resolve(row.root_path),
        local_db_path: resolve(localDbPath),
        ...(typeof row.name === 'string' && row.name ? { project_name: row.name } : {}),
        root_exists: existsSync(resolve(row.root_path)),
      });
    } catch {
      // A corrupt/unreadable local DB is not evidence and never relaxes the
      // central-catalog failure. The original planning error remains fatal.
    } finally {
      db?.close();
    }
  }
  return evidence.sort((left, right) => left.local_db_path.localeCompare(right.local_db_path));
}

