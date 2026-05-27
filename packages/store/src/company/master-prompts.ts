import type { Database as DB } from 'better-sqlite3';
import type {
  MasterPrompt,
  MasterPromptKind,
  MasterPromptOption,
  MasterPromptStatus,
} from '@mcp/company/types.js';

interface MasterPromptRow {
  id: number;
  company_session_id: number;
  agent_run_id: number | null;
  kind: string;
  runner_block_id: string | null;
  body: string;
  options_json: string | null;
  allow_freeform: number;
  status: string;
  answer: string | null;
  approved: number | null;
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}

function mapMasterPromptRow(row: MasterPromptRow): MasterPrompt {
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    agent_run_id: row.agent_run_id,
    kind: row.kind as MasterPromptKind,
    runner_block_id: row.runner_block_id,
    body: row.body,
    options: row.options_json ? (JSON.parse(row.options_json) as MasterPromptOption[]) : null,
    allow_freeform: row.allow_freeform !== 0,
    status: row.status as MasterPromptStatus,
    answer: row.answer,
    approved: row.approved == null ? null : row.approved !== 0,
    feedback: row.feedback,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

export interface CreateMasterPromptInput {
  company_session_id: number;
  agent_run_id: number | null;
  kind: MasterPromptKind;
  runner_block_id?: string | null;
  body: string;
  options?: MasterPromptOption[] | null;
  allow_freeform?: boolean;
}

export type ResolveMasterPromptInput =
  | { kind: 'question'; answer: string }
  | { kind: 'plan'; approved: boolean; feedback?: string };

export function create(db: DB, input: CreateMasterPromptInput): MasterPrompt {
  const stmt = db.prepare(`
    INSERT INTO company_master_prompts
      (company_session_id, agent_run_id, kind, runner_block_id, body,
       options_json, allow_freeform)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.company_session_id,
    input.agent_run_id,
    input.kind,
    input.runner_block_id ?? null,
    input.body,
    input.options ? JSON.stringify(input.options) : null,
    input.allow_freeform === false ? 0 : 1,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): MasterPrompt | null {
  const row = db
    .prepare('SELECT * FROM company_master_prompts WHERE id = ?')
    .get(id) as MasterPromptRow | undefined;
  return row ? mapMasterPromptRow(row) : null;
}

export function list(
  db: DB,
  companySessionId: number,
  opts?: { limit?: number; status?: MasterPromptStatus },
): MasterPrompt[] {
  const clauses: string[] = ['company_session_id = ?', 'archive_id IS NULL'];
  const params: unknown[] = [companySessionId];
  if (opts?.status) { clauses.push('status = ?'); params.push(opts.status); }
  const limit = opts?.limit ?? 100;
  params.push(limit);
  const sql =
    `SELECT * FROM (
       SELECT * FROM company_master_prompts
       WHERE ${clauses.join(' AND ')}
       ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...params) as MasterPromptRow[];
  return rows.map(mapMasterPromptRow);
}

/**
 * Resolve a pending prompt with the human's answer. Returns the updated
 * prompt, or null if not pending (already answered/cancelled — wins-the-race
 * semantics for concurrent shutdown).
 */
export function resolve(db: DB, id: number, resolution: ResolveMasterPromptInput): MasterPrompt | null {
  const stmt = resolution.kind === 'question'
    ? db.prepare(`
        UPDATE company_master_prompts
           SET status = 'answered',
               answer = ?,
               resolved_at = datetime('now')
         WHERE id = ? AND status = 'pending' AND kind = 'question'
      `)
    : db.prepare(`
        UPDATE company_master_prompts
           SET status = 'answered',
               approved = ?,
               feedback = ?,
               resolved_at = datetime('now')
         WHERE id = ? AND status = 'pending' AND kind = 'plan'
      `);
  const result = resolution.kind === 'question'
    ? stmt.run(resolution.answer, id)
    : stmt.run(resolution.approved ? 1 : 0, resolution.feedback ?? null, id);
  if (result.changes === 0) return null;
  return get(db, id);
}

/**
 * Mark every still-pending prompt for the session as cancelled. Returns the
 * list of cancelled prompts so callers can publish `master_prompt_cancelled`
 * events.
 */
export function cancelPending(db: DB, companySessionId: number): MasterPrompt[] {
  const pending = list(db, companySessionId, { status: 'pending' });
  if (pending.length === 0) return [];
  db.prepare(`
    UPDATE company_master_prompts
       SET status = 'cancelled', resolved_at = datetime('now')
     WHERE company_session_id = ? AND status = 'pending'
  `).run(companySessionId);
  return pending
    .map((p) => get(db, p.id))
    .filter((p): p is MasterPrompt => p !== null);
}

export function getPending(db: DB, companySessionId: number, kind?: MasterPromptKind): MasterPrompt | null {
  const sql = kind
    ? `SELECT * FROM company_master_prompts
       WHERE company_session_id = ? AND status = 'pending' AND kind = ?
       ORDER BY id DESC LIMIT 1`
    : `SELECT * FROM company_master_prompts
       WHERE company_session_id = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1`;
  const params = kind ? [companySessionId, kind] : [companySessionId];
  const row = db.prepare(sql).get(...params) as MasterPromptRow | undefined;
  return row ? mapMasterPromptRow(row) : null;
}
