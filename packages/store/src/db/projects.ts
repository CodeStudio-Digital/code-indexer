import type { Project } from '@mcp/shared/types.js';
import type { DB } from './types.js';
import { repairCodeFtsIndexes } from './schema/fts.js';
import { FileLocalHistoryStore } from '../file-local-history-store.js';

/** Limpa o Local History de um projeto (rows + blobs órfãos). Tolerante a schema sem a tabela. */
function pruneLocalHistory(db: DB, projectId: number): void {
  try {
    new FileLocalHistoryStore(db).pruneForProject(projectId);
  } catch (e) {
    if (!/no such table|no such column/i.test((e as Error).message)) throw e;
  }
}

type ProjectUpdates = Partial<Pick<Project,
  'name' | 'description' | 'group_name' | 'root_path' | 'provider' | 'model' |
  'last_indexed' | 'structural_indexed_at' | 'file_count' | 'symbol_count' |
  'embeddings_enabled' | 'search_mode' |
  'node_version' | 'runner_shell' | 'builder_json' | 'language_levels' | 'runtime_versions' |
  'package_managers' | 'wsl_runtime_versions' | 'wsl_package_managers' | 'git_remote' | 'default_branch'
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

/** Windows-tolerant root comparison: slashes, trailing separator, case. */
function normalizeRootPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function getByPath(db: DB, rootPath: string): Project | undefined {
  const exact = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as Project | undefined;
  if (exact) return exact;
  // The old fallback was `LIKE '%' || ?` — a SUFFIX match that could resolve
  // a DIFFERENT project (e.g. any root ending in "\backend") and feed the
  // structural indexer the wrong root (worst case: empty scan → index wipe,
  // now also blocked by the anti-wipe guard). Normalized equality only.
  const target = normalizeRootPath(rootPath);
  return (db.prepare('SELECT * FROM projects').all() as Project[])
    .find((p) => p.root_path && normalizeRootPath(p.root_path) === target);
}

export function list(db: DB): Project[] {
  // id 0 is the reserved hidden "__user__" project that holds user-scope
  // memory (migration 145) — never a real, listable project.
  // `is_synthetic` (migration 155) hides the virtual union projects backing
  // global sessions; `is_loose` (migration 176) hides ad-hoc folders attached
  // to a global session from an arbitrary path — both implementation details,
  // not user-facing in the "Projetos" grid.
  return db
    .prepare(
      "SELECT * FROM projects WHERE id <> 0 AND COALESCE(is_synthetic, 0) = 0 AND COALESCE(is_loose, 0) = 0 ORDER BY name",
    )
    .all() as Project[];
}

/** Projects offered in the GLOBAL-session project picker: every real project
 *  PLUS loose ad-hoc folders (migration 176), but NOT the synthetic unions
 *  (those would nest a workspace inside a workspace). Superset of `list()`. */
export function listForGlobalPicker(db: DB): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE id <> 0 AND COALESCE(is_synthetic, 0) = 0 ORDER BY name")
    .all() as Project[];
}

/** The synthetic global-session union projects (migration 155) — for the
 *  "reuse workspace" picker. Hidden from the normal `list()`. */
export function listSynthetic(db: DB): Project[] {
  return db
    .prepare("SELECT * FROM projects WHERE COALESCE(is_synthetic, 0) = 1 ORDER BY updated_at DESC")
    .all() as Project[];
}

/** Mark a project as synthetic (a global-session virtual union) — hides it from
 *  the project list (migration 155). */
export function setSynthetic(db: DB, id: number, synthetic: boolean): void {
  try {
    db.prepare("UPDATE projects SET is_synthetic = ? WHERE id = ?").run(synthetic ? 1 : 0, id);
  } catch {
    /* pre-155 DB without the column — caller tolerates (synthetic stays implicit). */
  }
}

/** Mark a project as a loose ad-hoc global-session folder — hides it from the
 *  "Projetos" grid (migration 176). Tolerant of a pre-176 DB. */
export function setLoose(db: DB, id: number, loose: boolean): void {
  try {
    db.prepare("UPDATE projects SET is_loose = ? WHERE id = ?").run(loose ? 1 : 0, id);
  } catch {
    /* pre-176 DB without the column — caller tolerates (loose stays implicit). */
  }
}

/** Loose ad-hoc folders (migration 176) NOT referenced by any global session —
 *  neither as a junction member (`coder_session_projects`) nor as a session's
 *  own `project_id`. Used by the boot sweep to GC folders left by deleted
 *  global sessions. Tolerant of a pre-176 / pre-152 DB (returns []). */
export function listOrphanLoose(db: DB): Project[] {
  try {
    return db
      .prepare(
        `SELECT * FROM projects p
          WHERE COALESCE(p.is_loose, 0) = 1
            AND NOT EXISTS (SELECT 1 FROM coder_session_projects csp WHERE csp.project_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM coder_sessions s WHERE s.project_id = p.id)`,
      )
      .all() as Project[];
  } catch {
    return [];
  }
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
  pruneLocalHistory(db, id);
  // `DELETE FROM projects` cascades (ON DELETE CASCADE) into `files`/`snapshots`,
  // firing their AFTER-DELETE FTS triggers. A corrupt FTS5 index throws
  // SQLITE_CORRUPT_VTAB from those triggers even though the base tables are fine.
  // Mirror clearData(): rebuild the derived index from the base tables and retry
  // once, so a stale FTS doesn't turn project deletion into a 500.
  try {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CORRUPT') || /malformed|SQLITE_CORRUPT/i.test((e as Error).message)) {
      repairCodeFtsIndexes(db);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    } else {
      throw e;
    }
  }
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
    pruneLocalHistory(db, projectId); // rows + blobs (decref correto)
    db.prepare(
      `UPDATE projects
         SET file_count = 0, symbol_count = 0, last_indexed = NULL,
             structural_indexed_at = NULL, updated_at = datetime('now')
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
