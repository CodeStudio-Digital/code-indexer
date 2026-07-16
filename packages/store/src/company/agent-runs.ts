import type { Database as DB } from 'better-sqlite3';
import type {
  AgentRunStatus,
  CompanyAgentDispatchSource,
  CompanyAgentRun,
} from '@mcp/company/types.js';

export interface CreateAgentRunInput {
  company_session_id: number;
  role: string;
  coder_session_id: number;
  project_ids: number[];
  provider: string;
  model: string;
  configured_provider?: string;
  configured_model?: string;
  dispatch_source?: CompanyAgentDispatchSource;
  fallback_reason?: string | null;
}

export function create(db: DB, input: CreateAgentRunInput): CompanyAgentRun {
  const stmt = db.prepare(`
    INSERT INTO company_agent_runs (
      company_session_id, role, coder_session_id, project_ids_json,
      provider, model, configured_provider, configured_model,
      dispatch_source, fallback_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    input.company_session_id,
    input.role,
    input.coder_session_id,
    JSON.stringify(input.project_ids),
    input.provider,
    input.model,
    input.configured_provider ?? input.provider,
    input.configured_model ?? input.model,
    input.dispatch_source ?? 'company',
    input.fallback_reason ?? null,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

/**
 * Serialize adoption of one durable coder session into an active Company
 * role. This avoids duplicate Master rows when two App facade reads race to
 * repair the same team from different server workers.
 */
export function getOrCreate(
  db: DB,
  input: CreateAgentRunInput,
): { run: CompanyAgentRun; created: boolean } {
  const transact = db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM company_agent_runs
      WHERE company_session_id = ?
        AND role = ?
        AND coder_session_id = ?
        AND archive_id IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(input.company_session_id, input.role, input.coder_session_id) as CompanyAgentRun | undefined;
    if (existing) return { run: existing, created: false };
    return { run: create(db, input), created: true };
  });
  return transact.immediate();
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

/** Statuses that count as "actively consuming capacity". */
const GLOBAL_ACTIVE_STATUSES = [
  'running', 'working',
  'waiting', 'waiting_plan', 'waiting_question', 'waiting_tasks',
  'reviewing', 'blocked',
] as const;

/**
 * Count subordinate runs actively consuming capacity ACROSS ALL company
 * sessions (archive_id IS NULL, role != 'master'). Powers the global spawn
 * budget: every company worker shares this one SQLite file, so any worker reads
 * the org-wide load directly — no cross-worker coordinator or RPC needed, and
 * no leak (the count is DB truth, not an in-memory counter).
 */
export function countActiveSubordinatesGlobal(db: DB): number {
  const placeholders = GLOBAL_ACTIVE_STATUSES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM company_agent_runs
       WHERE archive_id IS NULL AND role != 'master' AND status IN (${placeholders})`,
    )
    .get(...GLOBAL_ACTIVE_STATUSES) as { n: number };
  return row.n;
}

export function listArchived(db: DB, archiveId: number): CompanyAgentRun[] {
  return db
    .prepare('SELECT * FROM company_agent_runs WHERE archive_id = ? ORDER BY created_at ASC')
    .all(archiveId) as CompanyAgentRun[];
}

export function updateProvider(
  db: DB,
  id: number,
  provider: string,
  model: string,
  fallbackReason?: string | null,
): void {
  db.prepare(`
    UPDATE company_agent_runs
    SET provider = ?, model = ?, fallback_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(provider, model, fallbackReason ?? null, id);
}

/**
 * Replace the complete persisted runtime snapshot for a dormant/adopted run.
 *
 * App Studio uses this only while rotating a Master conversation, before the
 * coder session is resumed. Keeping configured/effective/source in one write
 * prevents a historical coder session from retaining a stale (for example,
 * global mini) model while the Company row claims the App-configured model.
 */
export function updateRuntimeSnapshot(
  db: DB,
  id: number,
  input: {
    configuredProvider: string;
    configuredModel: string;
    effectiveProvider: string;
    effectiveModel: string;
    dispatchSource: CompanyAgentDispatchSource;
    fallbackReason?: string | null;
  },
): void {
  db.prepare(`
    UPDATE company_agent_runs
    SET configured_provider = ?, configured_model = ?,
        provider = ?, model = ?, dispatch_source = ?, fallback_reason = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    input.configuredProvider,
    input.configuredModel,
    input.effectiveProvider,
    input.effectiveModel,
    input.dispatchSource,
    input.fallbackReason ?? null,
    id,
  );
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
