/**
 * CompanyStore — CRUD for company templates, sessions, agent runs, and board.
 *
 * Follows the same pattern as SessionStore: raw `better-sqlite3` prepared
 * statements, WAL mode, foreign keys ON. Schema is owned by migration 018.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  CompanyTemplate,
  CompanyRoleConfig,
  CompanySession,
  CompanySessionStatus,
  CompanySessionProject,
  CompanyAgentRun,
  AgentRunStatus,
  BoardEntry,
  BoardKind,
} from '../core/coder/company/types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

interface BoardRow {
  id: number;
  company_session_id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: string;
  content: string;
  mentions_json: string;
  created_at: string;
}

function mapBoardRow(row: BoardRow): BoardEntry {
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    author_role: row.author_role,
    agent_run_id: row.agent_run_id,
    kind: row.kind as BoardKind,
    content: row.content,
    mentions: JSON.parse(row.mentions_json || '[]'),
    created_at: row.created_at,
  };
}

interface TemplateRow {
  id: number;
  name: string;
  description: string;
  roles_json: string;
  created_at: string;
  updated_at: string;
}

function mapTemplateRow(row: TemplateRow): CompanyTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    roles: JSON.parse(row.roles_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class CompanyStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  close(): void {
    this.db.close();
  }

  // ─── Templates ─────────────────────────────────────────────────

  createTemplate(name: string, description: string, roles: CompanyRoleConfig[]): CompanyTemplate {
    const stmt = this.db.prepare(`
      INSERT INTO company_templates (name, description, roles_json)
      VALUES (?, ?, ?)
    `);
    const r = stmt.run(name, description, JSON.stringify(roles));
    return this.getTemplate(Number(r.lastInsertRowid))!;
  }

  getTemplate(id: number): CompanyTemplate | null {
    const row = this.db
      .prepare('SELECT * FROM company_templates WHERE id = ?')
      .get(id) as TemplateRow | undefined;
    return row ? mapTemplateRow(row) : null;
  }

  listTemplates(): CompanyTemplate[] {
    const rows = this.db
      .prepare('SELECT * FROM company_templates ORDER BY updated_at DESC')
      .all() as TemplateRow[];
    return rows.map(mapTemplateRow);
  }

  updateTemplate(id: number, patch: { name?: string; description?: string; roles?: CompanyRoleConfig[] }): CompanyTemplate | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (patch.roles !== undefined) { sets.push('roles_json = ?'); params.push(JSON.stringify(patch.roles)); }
    if (sets.length === 0) return this.getTemplate(id);
    sets.push("updated_at = datetime('now')");
    params.push(id);
    this.db.prepare(`UPDATE company_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getTemplate(id);
  }

  deleteTemplate(id: number): boolean {
    const r = this.db.prepare('DELETE FROM company_templates WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Company Sessions ──────────────────────────────────────────

  createCompanySession(input: {
    template_id?: number | null;
    name: string;
    config_json?: string;
  }): CompanySession {
    const stmt = this.db.prepare(`
      INSERT INTO company_sessions (template_id, name, config_json)
      VALUES (?, ?, ?)
    `);
    const r = stmt.run(
      input.template_id ?? null,
      input.name,
      input.config_json ?? '{}',
    );
    return this.getCompanySession(Number(r.lastInsertRowid))!;
  }

  getCompanySession(id: number): CompanySession | null {
    return this.db
      .prepare('SELECT * FROM company_sessions WHERE id = ?')
      .get(id) as CompanySession | undefined ?? null;
  }

  listCompanySessions(opts?: { status?: CompanySessionStatus }): CompanySession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) { clauses.push('status = ?'); params.push(opts.status); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM company_sessions ${where} ORDER BY updated_at DESC`)
      .all(...params) as CompanySession[];
  }

  updateCompanySessionStatus(id: number, status: CompanySessionStatus): void {
    this.db.prepare(`
      UPDATE company_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, id);
  }

  setMasterSessionId(id: number, masterSessionId: number): void {
    this.db.prepare(`
      UPDATE company_sessions SET master_session_id = ?, updated_at = datetime('now') WHERE id = ?
    `).run(masterSessionId, id);
  }

  setLastUserMessage(id: number, message: string): void {
    // Add column idempotently if it doesn't exist yet
    try {
      this.db.prepare(`ALTER TABLE company_sessions ADD COLUMN last_user_message TEXT`).run();
    } catch { /* column already exists */ }
    this.db.prepare(`
      UPDATE company_sessions SET last_user_message = ?, updated_at = datetime('now') WHERE id = ?
    `).run(message, id);
  }

  deleteCompanySession(id: number): boolean {
    const r = this.db.prepare('DELETE FROM company_sessions WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Projects ──────────────────────────────────────────────────

  addProjectToCompanySession(companySessionId: number, projectId: number, label?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO company_session_projects (company_session_id, project_id, label)
      VALUES (?, ?, ?)
    `).run(companySessionId, projectId, label ?? null);
  }

  listCompanySessionProjects(companySessionId: number): CompanySessionProject[] {
    return this.db
      .prepare('SELECT * FROM company_session_projects WHERE company_session_id = ?')
      .all(companySessionId) as CompanySessionProject[];
  }

  // ─── Agent Runs ────────────────────────────────────────────────

  createAgentRun(input: {
    company_session_id: number;
    role: string;
    coder_session_id: number;
    project_ids: number[];
    provider: string;
    model: string;
  }): CompanyAgentRun {
    const stmt = this.db.prepare(`
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
    return this.getAgentRun(Number(r.lastInsertRowid))!;
  }

  getAgentRun(id: number): CompanyAgentRun | null {
    return this.db
      .prepare('SELECT * FROM company_agent_runs WHERE id = ?')
      .get(id) as CompanyAgentRun | undefined ?? null;
  }

  listAgentRuns(companySessionId: number): CompanyAgentRun[] {
    return this.db
      .prepare('SELECT * FROM company_agent_runs WHERE company_session_id = ? ORDER BY created_at ASC')
      .all(companySessionId) as CompanyAgentRun[];
  }

  updateAgentRunStatus(id: number, status: AgentRunStatus, statusMessage?: string): void {
    if (statusMessage !== undefined) {
      this.db.prepare(`
        UPDATE company_agent_runs SET status = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, statusMessage, id);
    } else {
      this.db.prepare(`
        UPDATE company_agent_runs SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, id);
    }
  }

  // ─── Board ─────────────────────────────────────────────────────

  postToBoard(
    companySessionId: number,
    authorRole: string,
    agentRunId: number | null,
    kind: BoardKind,
    content: string,
    mentions?: string[],
  ): BoardEntry {
    const stmt = this.db.prepare(`
      INSERT INTO company_board (company_session_id, author_role, agent_run_id, kind, content, mentions_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      companySessionId,
      authorRole,
      agentRunId,
      kind,
      content,
      JSON.stringify(mentions ?? []),
    );
    return this.getBoardEntry(Number(r.lastInsertRowid))!;
  }

  getBoardEntry(id: number): BoardEntry | null {
    const row = this.db
      .prepare('SELECT * FROM company_board WHERE id = ?')
      .get(id) as BoardRow | undefined;
    return row ? mapBoardRow(row) : null;
  }

  readBoard(
    companySessionId: number,
    opts?: { sinceId?: number; limit?: number; kind?: BoardKind },
  ): BoardEntry[] {
    const clauses: string[] = ['company_session_id = ?'];
    const params: unknown[] = [companySessionId];
    if (opts?.sinceId != null) { clauses.push('id > ?'); params.push(opts.sinceId); }
    if (opts?.kind) { clauses.push('kind = ?'); params.push(opts.kind); }
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM company_board WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ?`)
      .all(...params) as BoardRow[];
    return rows.map(mapBoardRow);
  }

  /** Get the full company session with projects and agent runs. */
  getCompanySessionFull(id: number): {
    session: CompanySession;
    projects: CompanySessionProject[];
    agentRuns: CompanyAgentRun[];
    recentBoard: BoardEntry[];
  } | null {
    const session = this.getCompanySession(id);
    if (!session) return null;
    return {
      session,
      projects: this.listCompanySessionProjects(id),
      agentRuns: this.listAgentRuns(id),
      recentBoard: this.readBoard(id, { limit: 50 }),
    };
  }
}
