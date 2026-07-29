import type { Database as DB } from 'better-sqlite3';
import type { Pipeline, PipelineGraph } from '@mcp/company/types.js';

interface PipelineRow {
  id: number;
  name: string;
  description: string;
  project_id: number | null;
  template_id: number | null;
  graph_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapPipelineRow(row: PipelineRow): Pipeline {
  let graph: PipelineGraph;
  try { graph = JSON.parse(row.graph_json) as PipelineGraph; }
  catch { graph = { version: 1, nodes: [], edges: [] }; }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    project_id: row.project_id,
    company_session_id: null,
    template_id: row.template_id,
    graph,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreatePipelineInput {
  name: string;
  description?: string;
  graph: PipelineGraph;
  /** Chat/project scope. Mutually exclusive with `companySessionId`. */
  projectId?: number | null;
  /**
   * Accepted only so the CompanyStore facade can expose one input shape.
   * This SQLite module rejects non-null values; Company-session definitions
   * are written by the filesystem repository.
   */
  companySessionId?: string | null;
  templateId?: number | null;
}

export interface ListPipelinesOptions {
  templateId?: number | null;
  /**
   * Project scope: list pipelines owned by this project OR global ones
   * (both owners NULL). This is the clean per-project filter used by the
   * chat builder/picker.
   */
  projectId?: number;
}

export function create(db: DB, input: CreatePipelineInput): Pipeline {
  const projectId = input.projectId ?? null;
  const companySessionId = input.companySessionId ?? null;
  if (projectId !== null && companySessionId !== null) {
    const err = new Error('Pipeline scope must be project OR company, not both');
    (err as { code?: string }).code = 'PIPELINE_SCOPE_CONFLICT';
    throw err;
  }
  if (companySessionId !== null) {
    throw new Error(
      'Session-scoped pipeline definitions must use the filesystem repository',
    );
  }
  const stmt = db.prepare(`
    INSERT INTO pipelines (name, description, project_id, template_id, graph_json, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const r = stmt.run(
    input.name,
    input.description ?? '',
    projectId,
    input.templateId ?? null,
    JSON.stringify(input.graph),
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): Pipeline | null {
  const row = db
    .prepare('SELECT * FROM pipelines WHERE id = ?')
    .get(id) as PipelineRow | undefined;
  return row ? mapPipelineRow(row) : null;
}

export function list(db: DB, opts?: ListPipelinesOptions): Pipeline[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts && typeof opts.projectId === 'number') {
    where.push(
      '(project_id = ? OR project_id IS NULL)',
    );
    params.push(opts.projectId);
  }
  if (opts && typeof opts.templateId === 'number') {
    where.push('template_id = ?');
    params.push(opts.templateId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM pipelines ${whereSql} ORDER BY updated_at DESC, id DESC`;
  const rows = db.prepare(sql).all(...params) as PipelineRow[];
  return rows.map(mapPipelineRow);
}

/**
 * Optimistic locking via `expectedVersion` — on mismatch throws with code
 * `PIPELINE_VERSION_MISMATCH` so the route layer can return 409.
 */
export function update(
  db: DB,
  id: number,
  patch: { name?: string; description?: string; graph?: PipelineGraph },
  opts?: { expectedVersion?: number },
): Pipeline | null {
  const cur = get(db, id);
  if (!cur) return null;
  if (opts && typeof opts.expectedVersion === 'number' && cur.version !== opts.expectedVersion) {
    const err = new Error(`Pipeline ${id} version mismatch: expected ${opts.expectedVersion}, got ${cur.version}`);
    (err as { code?: string }).code = 'PIPELINE_VERSION_MISMATCH';
    throw err;
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
  if (patch.graph !== undefined) { sets.push('graph_json = ?'); params.push(JSON.stringify(patch.graph)); }
  if (sets.length === 0) return cur;
  sets.push("updated_at = datetime('now')");
  sets.push('version = version + 1');
  params.push(id);
  db.prepare(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return get(db, id);
}

export function del(db: DB, id: number): boolean {
  const r = db
    .prepare('DELETE FROM pipelines WHERE id = ?')
    .run(id);
  return r.changes > 0;
}
