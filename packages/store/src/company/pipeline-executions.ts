import type { Database as DB } from 'better-sqlite3';
import type {
  PipelineExecution,
  PipelineExecutionContext,
  PipelineExecutionStatus,
} from '@mcp/company/types.js';

interface ExecutionRow {
  id: number;
  pipeline_id: number;
  project_id: number | null;
  company_session_id: number | null;
  coder_session_id: number | null;
  status: string;
  current_node_id: string | null;
  initial_input: string;
  context_json: string;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

function mapExecutionRow(row: ExecutionRow): PipelineExecution {
  let context: PipelineExecutionContext = {
    snapshot: { version: 1, nodes: [], edges: [] },
    vars: {},
  };
  try {
    const parsed = JSON.parse(row.context_json) as Partial<PipelineExecutionContext>;
    if (parsed.snapshot) context.snapshot = parsed.snapshot;
    if (parsed.vars) context.vars = parsed.vars;
  } catch { /* fall back to empty */ }
  return {
    id: row.id,
    pipeline_id: row.pipeline_id,
    project_id: row.project_id,
    company_session_id: row.company_session_id,
    coder_session_id: row.coder_session_id,
    status: row.status as PipelineExecutionStatus,
    current_node_id: row.current_node_id,
    initial_input: row.initial_input,
    context,
    started_by: row.started_by,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error_message: row.error_message,
  };
}

export interface CreateExecutionInput {
  pipelineId: number;
  /** Project that owns a chat/project run; derived from the coder session. */
  projectId?: number | null;
  companySessionId?: number | null;
  coderSessionId?: number | null;
  initialInput: string;
  context: PipelineExecutionContext;
  startedBy?: string;
  currentNodeId?: string | null;
}

export interface ListExecutionsOptions {
  companySessionId?: number;
  coderSessionId?: number;
  pipelineId?: number;
  status?: PipelineExecutionStatus;
  limit?: number;
}

/**
 * Exactly one of `companySessionId` / `coderSessionId` must be set — the
 * DB-level CHECK in migration 077 enforces this.
 */
export function create(db: DB, input: CreateExecutionInput): PipelineExecution {
  const companyId = input.companySessionId ?? null;
  const coderId = input.coderSessionId ?? null;
  if ((companyId == null) === (coderId == null)) {
    throw new Error('createPipelineExecution: exactly one of companySessionId / coderSessionId must be set');
  }
  const stmt = db.prepare(`
    INSERT INTO pipeline_executions
      (pipeline_id, project_id, company_session_id, coder_session_id, status, current_node_id,
       initial_input, context_json, started_by)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.pipelineId,
    input.projectId ?? null,
    companyId,
    coderId,
    input.currentNodeId ?? null,
    input.initialInput,
    JSON.stringify(input.context),
    input.startedBy ?? 'master',
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): PipelineExecution | null {
  const row = db.prepare('SELECT * FROM pipeline_executions WHERE id = ?').get(id) as ExecutionRow | undefined;
  return row ? mapExecutionRow(row) : null;
}

export function list(db: DB, opts: ListExecutionsOptions): PipelineExecution[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof opts.companySessionId === 'number') { where.push('company_session_id = ?'); params.push(opts.companySessionId); }
  if (typeof opts.coderSessionId === 'number') { where.push('coder_session_id = ?'); params.push(opts.coderSessionId); }
  if (typeof opts.pipelineId === 'number') { where.push('pipeline_id = ?'); params.push(opts.pipelineId); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  let sql = `SELECT * FROM pipeline_executions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC`;
  if (typeof opts.limit === 'number') sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
  const rows = db.prepare(sql).all(...params) as ExecutionRow[];
  return rows.map(mapExecutionRow);
}

export function update(
  db: DB,
  id: number,
  patch: {
    status?: PipelineExecutionStatus;
    currentNodeId?: string | null;
    context?: PipelineExecutionContext;
    finishedAt?: string | null;
    errorMessage?: string | null;
  },
): PipelineExecution | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.currentNodeId !== undefined) { sets.push('current_node_id = ?'); params.push(patch.currentNodeId); }
  if (patch.context !== undefined) { sets.push('context_json = ?'); params.push(JSON.stringify(patch.context)); }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt); }
  if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); params.push(patch.errorMessage); }
  if (sets.length === 0) return get(db, id);
  params.push(id);
  db.prepare(`UPDATE pipeline_executions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return get(db, id);
}
