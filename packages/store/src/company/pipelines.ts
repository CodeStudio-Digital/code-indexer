import type { Database as DB } from 'better-sqlite3';
import type { Pipeline, PipelineGraph } from '@mcp/company/types.js';

interface PipelineRow {
  id: number;
  name: string;
  description: string;
  company_session_id: number | null;
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
    company_session_id: row.company_session_id,
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
  companySessionId?: number | null;
  templateId?: number | null;
}

export interface ListPipelinesOptions {
  companySessionId?: number | null;
  templateId?: number | null;
  /**
   * Chat-mode filter: list pipelines that are EITHER global
   * (`company_session_id IS NULL`) OR bound to a company session that
   * includes this project. Mutually exclusive with `companySessionId`.
   */
  projectIdForChat?: number;
}

export function create(db: DB, input: CreatePipelineInput): Pipeline {
  const stmt = db.prepare(`
    INSERT INTO pipelines (name, description, company_session_id, template_id, graph_json, version)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const r = stmt.run(
    input.name,
    input.description ?? '',
    input.companySessionId ?? null,
    input.templateId ?? null,
    JSON.stringify(input.graph),
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): Pipeline | null {
  const row = db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as PipelineRow | undefined;
  return row ? mapPipelineRow(row) : null;
}

export function list(db: DB, opts?: ListPipelinesOptions): Pipeline[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts && 'companySessionId' in opts) {
    if (opts.companySessionId === null) {
      where.push('company_session_id IS NULL');
    } else if (typeof opts.companySessionId === 'number') {
      where.push('(company_session_id = ? OR company_session_id IS NULL)');
      params.push(opts.companySessionId);
    }
  }
  if (opts && typeof opts.projectIdForChat === 'number') {
    where.push(
      '(company_session_id IS NULL OR company_session_id IN ' +
        '(SELECT company_session_id FROM company_session_projects WHERE project_id = ?))',
    );
    params.push(opts.projectIdForChat);
  }
  if (opts && typeof opts.templateId === 'number') {
    where.push('template_id = ?');
    params.push(opts.templateId);
  }
  const sql = `SELECT * FROM pipelines${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC`;
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
  const r = db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
  return r.changes > 0;
}
