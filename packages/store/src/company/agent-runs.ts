import type { Database as DB } from 'better-sqlite3';
import type { AgentRunStatus, CompanyAgentRun } from '@mcp/company/types.js';

export interface CreateAgentRunInput {
  company_session_id: number;
  role: string;
  coder_session_id: number;
  project_ids: number[];
  provider: string;
  model: string;
}

export function create(db: DB, input: CreateAgentRunInput): CompanyAgentRun {
  const stmt = db.prepare(`
    INSERT INTO company_agent_runs (company_session_id, role, coder_session_id, project_ids_json, provider, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.company_session_id,
    input.role,
    input.coder_session_id,
    JSON.stringify(input.project_ids),
    input.provider,
    input.model,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): CompanyAgentRun | null {
  return db
    .prepare('SELECT * FROM company_agent_runs WHERE id = ?')
    .get(id) as CompanyAgentRun | undefined ?? null;
}

/**
 * List ACTIVE agent runs (archive_id IS NULL). To list an archived snapshot's
 * runs, use `listArchived` instead.
 */
export function list(db: DB, companySessionId: number): CompanyAgentRun[] {
  return db
    .prepare('SELECT * FROM company_agent_runs WHERE company_session_id = ? AND archive_id IS NULL ORDER BY created_at ASC')
    .all(companySessionId) as CompanyAgentRun[];
}

export function listArchived(db: DB, archiveId: number): CompanyAgentRun[] {
  return db
    .prepare('SELECT * FROM company_agent_runs WHERE archive_id = ? ORDER BY created_at ASC')
    .all(archiveId) as CompanyAgentRun[];
}

export function updateProvider(db: DB, id: number, provider: string, model: string): void {
  db.prepare(`
    UPDATE company_agent_runs SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?
  `).run(provider, model, id);
}

export function updateStatus(db: DB, id: number, status: AgentRunStatus, statusMessage?: string): void {
  if (statusMessage !== undefined) {
    db.prepare(`
      UPDATE company_agent_runs SET status = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, statusMessage, id);
  } else {
    db.prepare(`
      UPDATE company_agent_runs SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, id);
  }
}

/**
 * Hard-delete an agent run. FK constraints (enabled in CompanyStore) cascade:
 * `kanban_card_agents` rows CASCADE away, while `company_board` / `kanban_cards`
 * / `pipeline_node_executions` / `qa_test_runs` / `company_drive_files`
 * references are SET NULL. Telemetry tables without an FK (supervision,
 * watermarks, master_prompts) keep their rows harmlessly orphaned.
 */
export function remove(db: DB, id: number): void {
  db.prepare('DELETE FROM company_agent_runs WHERE id = ?').run(id);
}

/**
 * Sweep stale agent runs and company sessions left in an active state by a
 * crashed/restarted server. Should be called once at bootstrap, BEFORE the
 * HTTP listener accepts connections.
 *
 * Any row with status `running`/`working` is marked `interrupted` — the
 * in-memory orchestrator that owned it is gone. Company sessions in
 * `running` transition to `paused` so the user can resume via a follow-up
 * message. P15c (migration 091): stamps `recovered_at` + `recovered_reason`
 * so the dashboard's SessionHeader can render a "Recovered" pill.
 */
export function recoverStale(db: DB): { agentRuns: number; companySessions: number } {
  const agentRuns = db.prepare(`
    UPDATE company_agent_runs
    SET status = 'interrupted',
        status_message = COALESCE(status_message, '') || ' [recovered on server restart]',
        updated_at = datetime('now')
    WHERE status IN ('running', 'working') AND archive_id IS NULL
  `).run().changes;
  const companySessions = db.prepare(`
    UPDATE company_sessions
    SET status = 'paused',
        recovered_at = datetime('now'),
        recovered_reason = 'server_restart',
        updated_at = datetime('now')
    WHERE status = 'running'
  `).run().changes;
  return { agentRuns, companySessions };
}
