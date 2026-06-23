import type { Database as DB } from 'better-sqlite3';
import type {
  CompanySession,
  CompanySessionStatus,
} from '@mcp/company/types.js';

export interface CreateCompanySessionInput {
  template_id?: number | null;
  name: string;
  config_json?: string;
  parent_session_id?: number | null;
}

export interface ListSessionsOptions {
  status?: CompanySessionStatus;
  includeChildren?: boolean;
}

export function create(db: DB, input: CreateCompanySessionInput): CompanySession {
  const stmt = db.prepare(`
    INSERT INTO company_sessions (template_id, name, config_json, parent_session_id)
    VALUES (?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.template_id ?? null,
    input.name,
    input.config_json ?? '{}',
    input.parent_session_id ?? null,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

/**
 * Create a sub-session ("front") of a parent. Snapshots the parent's
 * `template_id` and `config_json` so role/provider/model defaults carry over.
 */
export function createChild(db: DB, parentSessionId: number, name: string): CompanySession {
  const parent = get(db, parentSessionId);
  if (!parent) throw new Error(`Parent session ${parentSessionId} not found`);
  if (parent.parent_session_id != null) {
    throw new Error('Cannot nest sub-sessions: parent must itself be a root session');
  }
  return create(db, {
    template_id: parent.template_id,
    name,
    config_json: parent.config_json,
    parent_session_id: parent.id,
  });
}

/**
 * `archived_at` filtering: until migration 087 the column didn't
 * exist and archived fronts came back on reload. We exclude any
 * child whose `archived_at` is set so `FrontTabsBar` stops
 * re-rendering deleted tabs.
 */
export function listChildren(db: DB, parentSessionId: number): CompanySession[] {
  return db
    .prepare(
      `SELECT * FROM company_sessions
       WHERE parent_session_id = ?
         AND archived_at IS NULL
       ORDER BY id ASC`,
    )
    .all(parentSessionId) as CompanySession[];
}

export function get(db: DB, id: number): CompanySession | null {
  return db
    .prepare('SELECT * FROM company_sessions WHERE id = ?')
    .get(id) as CompanySession | undefined ?? null;
}

/**
 * List sessions for the dashboard sidebar. Returns only ROOT sessions
 * (`parent_session_id IS NULL`) by default — sub-sessions render inline
 * as tabs inside their parent's view (migration 067).
 */
export function list(db: DB, opts?: ListSessionsOptions): CompanySession[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts?.status) { clauses.push('status = ?'); params.push(opts.status); }
  if (!opts?.includeChildren) {
    clauses.push('parent_session_id IS NULL');
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM company_sessions ${where} ORDER BY updated_at DESC`)
    .all(...params) as CompanySession[];
}

export function updateStatus(db: DB, id: number, status: CompanySessionStatus): void {
  db.prepare(`
    UPDATE company_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id);
}

export function rename(db: DB, id: number, name: string): void {
  db.prepare(`
    UPDATE company_sessions SET name = ?, updated_at = datetime('now') WHERE id = ?
  `).run(name, id);
}

export function setMasterSessionId(db: DB, id: number, masterSessionId: number): void {
  db.prepare(`
    UPDATE company_sessions SET master_session_id = ?, updated_at = datetime('now') WHERE id = ?
  `).run(masterSessionId, id);
}

export function setLastUserMessage(db: DB, id: number, message: string): void {
  // Idempotent column add for legacy DBs (pre-migration 091).
  try {
    db.prepare(`ALTER TABLE company_sessions ADD COLUMN last_user_message TEXT`).run();
  } catch { /* column already exists */ }
  db.prepare(`
    UPDATE company_sessions SET last_user_message = ?, updated_at = datetime('now') WHERE id = ?
  `).run(message, id);
}

export function del(db: DB, id: number): boolean {
  const r = db.prepare('DELETE FROM company_sessions WHERE id = ?').run(id);
  return r.changes > 0;
}

export function duplicate(db: DB, sourceId: number, newName: string): CompanySession {
  let newId = 0;
  const tx = db.transaction(() => {
    const source = db
      .prepare('SELECT * FROM company_sessions WHERE id = ?')
      .get(sourceId) as { config_json: string } | undefined;
    if (!source) throw new Error(`Session ${sourceId} not found`);

    const r = db
      .prepare(`INSERT INTO company_sessions (name, config_json, status) VALUES (?, ?, 'idle')`)
      .run(newName, source.config_json);
    newId = Number(r.lastInsertRowid);

    db.prepare(`
      INSERT INTO company_session_projects (company_session_id, project_id, label)
      SELECT ?, project_id, label FROM company_session_projects WHERE company_session_id = ?
    `).run(newId, sourceId);

    db.prepare(`
      INSERT INTO company_board (company_session_id, author_role, agent_run_id, kind, content, mentions_json, created_at)
      SELECT ?, author_role, NULL, kind, content, mentions_json, created_at
      FROM company_board WHERE company_session_id = ? AND archive_id IS NULL ORDER BY id
    `).run(newId, sourceId);

    db.prepare(`
      INSERT INTO company_master_prompts
        (company_session_id, agent_run_id, kind, runner_block_id, body, options_json, allow_freeform, status, answer, approved, feedback, created_at, resolved_at)
      SELECT ?, NULL, kind, NULL, body, options_json, allow_freeform, status, answer, approved, feedback, created_at, resolved_at
      FROM company_master_prompts
      WHERE company_session_id = ? AND archive_id IS NULL AND status != 'pending'
      ORDER BY id
    `).run(newId, sourceId);
  });

  tx();
  return get(db, newId)!;
}

export function updateConfig(db: DB, id: number, configJson: string): void {
  db.prepare(`
    UPDATE company_sessions SET config_json = ?, updated_at = datetime('now') WHERE id = ?
  `).run(configJson, id);
}

/**
 * Clear the P15c recovery flag on a single session. Called when the
 * session next transitions back to `running` (a fresh user message
 * resurrects the master). Idempotent.
 */
export function clearRecoveryFlag(db: DB, companySessionId: number): void {
  db.prepare(`
    UPDATE company_sessions
    SET recovered_at = NULL,
        recovered_reason = NULL
    WHERE id = ? AND recovered_at IS NOT NULL
  `).run(companySessionId);
}
