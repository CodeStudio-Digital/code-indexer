import type { Project } from '@mcp/shared/types.js';
import type { DB } from './types.js';
import { repairCodeFtsIndexes } from './schema/fts.js';

type ProjectUpdates = Partial<Pick<Project,
  'name' | 'description' | 'group_name' | 'root_path' | 'provider' | 'model' |
  'last_indexed' | 'file_count' | 'symbol_count' | 'embeddings_enabled' | 'search_mode' |
  'node_version' | 'runner_shell'
>>;

export function create(db: DB, name: string, rootPath: string, description?: string): Project {
  const stmt = db.prepare(`
    INSERT INTO projects (name, root_path, description)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(name, rootPath, description ?? null);
  return get(db, result.lastInsertRowid as number)!;
}

export function get(db: DB, id: number): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function getByName(db: DB, name: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
}

export function getByPath(db: DB, rootPath: string): Project | undefined {
  const exact = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Project | undefined;
  if (exact) return exact;
  return db.prepare("SELECT * FROM projects WHERE root_path LIKE '%' || ?").get(rootPath) as Project | undefined;
}

export function list(db: DB): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
}

export function update(db: DB, id: number, updates: ProjectUpdates): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function del(db: DB, id: number): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/**
 * Top-level project-scoped tables. Deleting these clears ALL of a project's
 * data because `ON DELETE CASCADE` + the FTS AFTER-DELETE triggers fan out to
 * the children (files → symbols/file_snapshots/file_concepts/file_dependencies/
 * symbol_references/symbol_relations/*_fts; runs → costs; snapshots →
 * snapshot_versions/*_fts; coder_sessions → coder_messages → coder_tool_calls;
 * pipelines → pipeline_executions). Listing only the parents keeps this from
 * silently going stale when a new child table is added.
 */
const PROJECT_SCOPED_TABLES = [
  'files',
  'runs',
  'snapshots',
  'webhooks',
  'vector_ids',
  'coder_session_groups',
  'coder_sessions',
  'pipelines',
  'pipeline_executions',
] as const;

/**
 * Wipe every bit of a project's indexed data, sessions, snapshots, runs and
 * costs — but KEEP the project row (name/root_path/config) so the user can
 * re-index without re-creating it. Counters are reset; vectors are handled by
 * the caller (it owns the remote VectorStore). Runs in one transaction.
 */
export function clearData(db: DB, id: number): void {
  const tx = db.transaction((projectId: number) => {
    for (const table of PROJECT_SCOPED_TABLES) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      } catch (e) {
        // Tolerate partial schemas (a table not created yet by migrations).
        if (!/no such table|no such column/i.test((e as Error).message)) throw e;
      }
    }
    db.prepare(
      `UPDATE projects
         SET file_count = 0, symbol_count = 0, last_indexed = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(projectId);
  });
  try {
    tx(id);
  } catch (e) {
    // A corrupt FTS5 index throws SQLITE_CORRUPT_VTAB from the AFTER-DELETE
    // triggers (the base tables are fine — only the derived index is bad).
    // Rebuild the FTS from the base tables and retry the clear once.
    const code = (e as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CORRUPT') || /malformed|SQLITE_CORRUPT/i.test((e as Error).message)) {
      repairCodeFtsIndexes(db);
      tx(id);
    } else {
      throw e;
    }
  }
}

export function resolve(db: DB, name?: string, rootPath?: string): Project {
  if (name) {
    const p = getByName(db, name);
    if (p) return p;
  }
  if (rootPath) {
    const p = getByPath(db, rootPath);
    if (p) return p;
  }

  const cwd = rootPath ?? process.cwd();
  const existing = getByPath(db, cwd);
  if (existing) return existing;

  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const autoName = parts.slice(-2).join('/');
  return create(db, name ?? autoName, cwd);
}
