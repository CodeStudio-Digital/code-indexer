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
  KanbanCard,
  KanbanColumn,
  KanbanTag,
  KanbanChecklistItem,
  KanbanComment,
  KanbanCardAgent,
  KanbanCardDependency,
  KanbanCardFull,
  MasterPrompt,
  MasterPromptKind,
  MasterPromptOption,
  MasterPromptStatus,
  CompanySessionArchive,
  Pipeline,
  PipelineGraph,
  PipelineExecution,
  PipelineExecutionContext,
  PipelineExecutionStatus,
  PipelineNodeExecution,
  PipelineNodeStatus,
  AgentInboxMessage,
  InboxKind,
  InboxStatus,
} from '@mcp/company/types.js';

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
  archive_id: number | null;
}

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
    archive_id: row.archive_id ?? null,
  };
}

// `TemplateRow` + `mapTemplateRow` moved to `company/templates.ts`
// alongside the five template CRUD methods. The class methods below
// delegate via 1-line wrappers.
import * as templatesDomain from './company/templates.js';

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
  // Bodies moved to `company/templates.ts`; the class keeps the API
  // surface as 1-line delegates.

  createTemplate(name: string, description: string, roles: CompanyRoleConfig[]): CompanyTemplate {
    return templatesDomain.createTemplate(this.db, name, description, roles);
  }

  getTemplate(id: number): CompanyTemplate | null {
    return templatesDomain.getTemplate(this.db, id);
  }

  listTemplates(): CompanyTemplate[] {
    return templatesDomain.listTemplates(this.db);
  }

  updateTemplate(
    id: number,
    patch: { name?: string; description?: string; roles?: CompanyRoleConfig[] },
  ): CompanyTemplate | null {
    return templatesDomain.updateTemplate(this.db, id, patch);
  }

  deleteTemplate(id: number): boolean {
    return templatesDomain.deleteTemplate(this.db, id);
  }

  // ─── Company Sessions ──────────────────────────────────────────

  createCompanySession(input: {
    template_id?: number | null;
    name: string;
    config_json?: string;
    parent_session_id?: number | null;
  }): CompanySession {
    const stmt = this.db.prepare(`
      INSERT INTO company_sessions (template_id, name, config_json, parent_session_id)
      VALUES (?, ?, ?, ?)
    `);
    const r = stmt.run(
      input.template_id ?? null,
      input.name,
      input.config_json ?? '{}',
      input.parent_session_id ?? null,
    );
    return this.getCompanySession(Number(r.lastInsertRowid))!;
  }

  /**
   * Create a sub-session ("front") of a parent. Snapshots the parent's
   * `template_id` and `config_json` so role/provider/model defaults
   * carry over; the new row's runtime state (board, agent_runs,
   * master_prompts, inbox) starts empty and isolated by FK.
   */
  createChildSession(input: {
    parent_session_id: number;
    name: string;
  }): CompanySession {
    const parent = this.getCompanySession(input.parent_session_id);
    if (!parent) throw new Error(`Parent session ${input.parent_session_id} not found`);
    if (parent.parent_session_id != null) {
      throw new Error('Cannot nest sub-sessions: parent must itself be a root session');
    }
    return this.createCompanySession({
      template_id: parent.template_id,
      name: input.name,
      config_json: parent.config_json,
      parent_session_id: parent.id,
    });
  }

  /**
   * List active (non-archived) sub-sessions of a parent, ordered by id
   * so the dashboard renders tabs in creation order.
   *
   * `archived_at` filtering: until migration 087 the column didn't
   * exist and archived fronts came back on reload. We exclude any
   * child whose `archived_at` is set so the dashboard's `FrontTabsBar`
   * stops re-rendering deleted tabs.
   */
  listChildSessions(parentSessionId: number): CompanySession[] {
    return this.db
      .prepare(
        `SELECT * FROM company_sessions
         WHERE parent_session_id = ?
           AND archived_at IS NULL
         ORDER BY id ASC`,
      )
      .all(parentSessionId) as CompanySession[];
  }

  getCompanySession(id: number): CompanySession | null {
    return this.db
      .prepare('SELECT * FROM company_sessions WHERE id = ?')
      .get(id) as CompanySession | undefined ?? null;
  }

  /**
   * List sessions for the dashboard sidebar. By default this returns
   * only ROOT sessions (`parent_session_id IS NULL`) so the sidebar
   * doesn't flood with sub-sessions ("front tabs") — they're rendered
   * inline as tabs inside their parent's view (migration 067). Pass
   * `includeChildren: true` for admin/diagnostic flows that want the
   * raw list.
   */
  listCompanySessions(opts?: {
    status?: CompanySessionStatus;
    includeChildren?: boolean;
  }): CompanySession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) { clauses.push('status = ?'); params.push(opts.status); }
    if (!opts?.includeChildren) {
      clauses.push('parent_session_id IS NULL');
    }
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

  renameCompanySession(id: number, name: string): void {
    this.db.prepare(`
      UPDATE company_sessions SET name = ?, updated_at = datetime('now') WHERE id = ?
    `).run(name, id);
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

  duplicateCompanySession(sourceId: number, newName: string): CompanySession {
    let newId = 0;
    const tx = this.db.transaction(() => {
      const source = this.db
        .prepare('SELECT * FROM company_sessions WHERE id = ?')
        .get(sourceId) as { config_json: string } | undefined;
      if (!source) throw new Error(`Session ${sourceId} not found`);

      const r = this.db
        .prepare(`INSERT INTO company_sessions (name, config_json, status) VALUES (?, ?, 'idle')`)
        .run(newName, source.config_json);
      newId = Number(r.lastInsertRowid);

      this.db.prepare(`
        INSERT INTO company_session_projects (company_session_id, project_id, label)
        SELECT ?, project_id, label FROM company_session_projects WHERE company_session_id = ?
      `).run(newId, sourceId);

      this.db.prepare(`
        INSERT INTO company_board (company_session_id, author_role, agent_run_id, kind, content, mentions_json, created_at)
        SELECT ?, author_role, NULL, kind, content, mentions_json, created_at
        FROM company_board WHERE company_session_id = ? AND archive_id IS NULL ORDER BY id
      `).run(newId, sourceId);

      this.db.prepare(`
        INSERT INTO company_master_prompts
          (company_session_id, agent_run_id, kind, runner_block_id, body, options_json, allow_freeform, status, answer, approved, feedback, created_at, resolved_at)
        SELECT ?, NULL, kind, NULL, body, options_json, allow_freeform, status, answer, approved, feedback, created_at, resolved_at
        FROM company_master_prompts
        WHERE company_session_id = ? AND archive_id IS NULL AND status != 'pending'
        ORDER BY id
      `).run(newId, sourceId);
    });

    tx();
    return this.getCompanySession(newId)!;
  }

  // ─── Projects ──────────────────────────────────────────────────

  addProjectToCompanySession(companySessionId: number, projectId: number, label?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO company_session_projects (company_session_id, project_id, label)
      VALUES (?, ?, ?)
    `).run(companySessionId, projectId, label ?? null);
  }

  /**
   * Unlink a project from a session. Does NOT delete the project row
   * itself — that's the caller's choice (virtual `_builder_*` rows are
   * deleted alongside; external projects are kept for reuse).
   *
   * The link table has no ON DELETE CASCADE toward `projects`, so
   * without this explicit cleanup deleting a service's virtual project
   * leaves an orphan row that shows up as `project-<id>` in the UI
   * (the enrichment falls back to a synthetic name when `db.getProject`
   * returns null).
   */
  removeProjectFromCompanySession(companySessionId: number, projectId: number): void {
    this.db.prepare(
      `DELETE FROM company_session_projects
       WHERE company_session_id = ? AND project_id = ?`,
    ).run(companySessionId, projectId);
  }

  /**
   * One-shot cleanup for orphan rows — link rows whose `project_id` no
   * longer exists in the `projects` table. Called from the session full
   * read so stale rows from past bugs disappear on their own as soon as
   * the user opens the session, without a migration that blindly
   * deletes history. Returns the number of rows removed.
   */
  pruneOrphanCompanySessionProjects(companySessionId: number): number {
    const res = this.db.prepare(
      `DELETE FROM company_session_projects
       WHERE company_session_id = ?
         AND project_id NOT IN (SELECT id FROM projects)`,
    ).run(companySessionId);
    return res.changes;
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

  /**
   * List ACTIVE agent runs (archive_id IS NULL). To list an archived
   * snapshot's runs, use `listArchivedAgentRuns(archiveId)` instead.
   */
  listAgentRuns(companySessionId: number): CompanyAgentRun[] {
    return this.db
      .prepare('SELECT * FROM company_agent_runs WHERE company_session_id = ? AND archive_id IS NULL ORDER BY created_at ASC')
      .all(companySessionId) as CompanyAgentRun[];
  }

  listArchivedAgentRuns(archiveId: number): CompanyAgentRun[] {
    return this.db
      .prepare('SELECT * FROM company_agent_runs WHERE archive_id = ? ORDER BY created_at ASC')
      .all(archiveId) as CompanyAgentRun[];
  }

  updateCompanySessionConfig(id: number, configJson: string): void {
    this.db.prepare(`
      UPDATE company_sessions SET config_json = ?, updated_at = datetime('now') WHERE id = ?
    `).run(configJson, id);
  }

  updateAgentRunProvider(id: number, provider: string, model: string): void {
    this.db.prepare(`
      UPDATE company_agent_runs SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?
    `).run(provider, model, id);
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

  /**
   * Sweep stale agent runs and company sessions left in an active state by
   * a crashed/restarted server. Should be called once at bootstrap, BEFORE
   * the HTTP listener accepts connections.
   *
   * Any row with status `running`/`working` is marked `interrupted` — the
   * in-memory orchestrator that owned it is gone, so the runner cannot
   * possibly still be alive. Company sessions in `running` transition to
   * `paused` so the user can resume via a follow-up message.
   *
   * Returns the count of rows touched (for logging).
   */
  recoverStaleAgentRuns(): { agentRuns: number; companySessions: number } {
    // Skip archived rows — they're historical snapshots, not live runs.
    const agentRuns = this.db.prepare(`
      UPDATE company_agent_runs
      SET status = 'interrupted',
          status_message = COALESCE(status_message, '') || ' [recovered on server restart]',
          updated_at = datetime('now')
      WHERE status IN ('running', 'working') AND archive_id IS NULL
    `).run().changes;
    // P15c (migration 091): stamp `recovered_at` + `recovered_reason`
    // so the dashboard's SessionHeader can render a "Recovered" pill
    // distinguishing this paused state from a user-initiated pause.
    // The pill clears when the session next transitions out of
    // `paused` (via `clearSessionRecoveryFlag` on the next message).
    const companySessions = this.db.prepare(`
      UPDATE company_sessions
      SET status = 'paused',
          recovered_at = datetime('now'),
          recovered_reason = 'server_restart',
          updated_at = datetime('now')
      WHERE status = 'running'
    `).run().changes;
    return { agentRuns, companySessions };
  }

  /**
   * Clear the P15c recovery flag on a single session. Called when the
   * session next transitions back to `running` (a fresh user message
   * resurrects the master). Idempotent.
   */
  clearSessionRecoveryFlag(companySessionId: number): void {
    this.db.prepare(`
      UPDATE company_sessions
      SET recovered_at = NULL,
          recovered_reason = NULL
      WHERE id = ? AND recovered_at IS NOT NULL
    `).run(companySessionId);
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
    const entry = this.getBoardEntry(Number(r.lastInsertRowid))!;
    return entry;
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
    // Active board only (archived snapshots read via readArchivedBoard).
    const clauses: string[] = ['company_session_id = ?', 'archive_id IS NULL'];
    const params: unknown[] = [companySessionId];
    if (opts?.sinceId != null) { clauses.push('id > ?'); params.push(opts.sinceId); }
    if (opts?.kind) { clauses.push('kind = ?'); params.push(opts.kind); }
    const limit = opts?.limit ?? 100;
    params.push(limit);
    const whereClause = clauses.join(' AND ');
    // With sinceId: fetch next N entries after that point (ASC is correct).
    // Without sinceId: fetch the LATEST N entries via DESC subquery, re-sorted ASC.
    const sql = opts?.sinceId != null
      ? `SELECT * FROM company_board WHERE ${whereClause} ORDER BY id ASC LIMIT ?`
      : `SELECT * FROM (SELECT * FROM company_board WHERE ${whereClause} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(...params) as BoardRow[];
    return rows.map(mapBoardRow);
  }

  /** Read all board entries belonging to a specific archive snapshot. */
  readArchivedBoard(archiveId: number): BoardEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM company_board WHERE archive_id = ? ORDER BY id ASC')
      .all(archiveId) as BoardRow[];
    return rows.map(mapBoardRow);
  }

  /** Get the full company session with projects and agent runs. */
  getCompanySessionFull(id: number): {
    session: CompanySession;
    projects: CompanySessionProject[];
    agentRuns: CompanyAgentRun[];
    recentBoard: BoardEntry[];
    masterPrompts: MasterPrompt[];
  } | null {
    const session = this.getCompanySession(id);
    if (!session) return null;
    return {
      session,
      projects: this.listCompanySessionProjects(id),
      agentRuns: this.listAgentRuns(id),
      recentBoard: this.readBoard(id, { limit: 50 }),
      masterPrompts: this.listMasterPrompts(id, { limit: 50 }),
    };
  }

  // ─── Master Prompts ────────────────────────────────────────────

  createMasterPrompt(input: {
    company_session_id: number;
    agent_run_id: number | null;
    kind: MasterPromptKind;
    runner_block_id?: string | null;
    body: string;
    options?: MasterPromptOption[] | null;
    allow_freeform?: boolean;
  }): MasterPrompt {
    const stmt = this.db.prepare(`
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
    return this.getMasterPrompt(Number(r.lastInsertRowid))!;
  }

  getMasterPrompt(id: number): MasterPrompt | null {
    const row = this.db
      .prepare('SELECT * FROM company_master_prompts WHERE id = ?')
      .get(id) as MasterPromptRow | undefined;
    return row ? mapMasterPromptRow(row) : null;
  }

  listMasterPrompts(
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
    const rows = this.db.prepare(sql).all(...params) as MasterPromptRow[];
    return rows.map(mapMasterPromptRow);
  }

  /**
   * Resolve a pending prompt with the human's answer. Returns the updated
   * prompt, or null if the prompt is not pending (already answered or
   * cancelled — wins-the-race semantics for concurrent shutdown).
   */
  resolveMasterPrompt(
    id: number,
    resolution:
      | { kind: 'question'; answer: string }
      | { kind: 'plan'; approved: boolean; feedback?: string },
  ): MasterPrompt | null {
    const stmt = resolution.kind === 'question'
      ? this.db.prepare(`
          UPDATE company_master_prompts
             SET status = 'answered',
                 answer = ?,
                 resolved_at = datetime('now')
           WHERE id = ? AND status = 'pending' AND kind = 'question'
        `)
      : this.db.prepare(`
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
    return this.getMasterPrompt(id);
  }

  /**
   * Mark every still-pending prompt for the session as cancelled.
   * Returns the list of cancelled prompts (so callers can publish
   * `master_prompt_cancelled` events).
   */
  cancelPendingMasterPrompts(companySessionId: number): MasterPrompt[] {
    const pending = this.listMasterPrompts(companySessionId, { status: 'pending' });
    if (pending.length === 0) return [];
    this.db.prepare(`
      UPDATE company_master_prompts
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE company_session_id = ? AND status = 'pending'
    `).run(companySessionId);
    return pending
      .map((p) => this.getMasterPrompt(p.id))
      .filter((p): p is MasterPrompt => p !== null);
  }

  /** Get the most recent pending prompt of a given kind, if any. */
  getPendingMasterPrompt(
    companySessionId: number,
    kind?: MasterPromptKind,
  ): MasterPrompt | null {
    const sql = kind
      ? `SELECT * FROM company_master_prompts
         WHERE company_session_id = ? AND status = 'pending' AND kind = ?
         ORDER BY id DESC LIMIT 1`
      : `SELECT * FROM company_master_prompts
         WHERE company_session_id = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1`;
    const params = kind ? [companySessionId, kind] : [companySessionId];
    const row = this.db.prepare(sql).get(...params) as MasterPromptRow | undefined;
    return row ? mapMasterPromptRow(row) : null;
  }

  // ─── Kanban ─────────────────────────────────────────────────────

  createKanbanCard(sessionId: number, input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    tag?: KanbanTag | null;
    created_by?: string;
  }): KanbanCard {
    const col = input.column ?? 'backlog';
    const maxPos = this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) as m FROM kanban_cards WHERE company_session_id = ? AND "column" = ?`
    ).get(sessionId, col) as { m: number };

    const stmt = this.db.prepare(`
      INSERT INTO kanban_cards (company_session_id, title, description, "column", position, tag, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      sessionId,
      input.title,
      input.description ?? '',
      col,
      maxPos.m + 1,
      input.tag ?? null,
      input.created_by ?? 'master',
    );
    const card = this.getKanbanCard(Number(r.lastInsertRowid))!;
    return card;
  }

  getKanbanCard(cardId: number): KanbanCard | null {
    const row = this.db
      .prepare('SELECT * FROM kanban_cards WHERE id = ?')
      .get(cardId) as KanbanCard | undefined;
    return row ?? null;
  }

  getKanbanCardFull(cardId: number): KanbanCardFull | null {
    const card = this.getKanbanCard(cardId);
    if (!card) return null;

    const checklist = this.db
      .prepare('SELECT * FROM kanban_checklist_items WHERE card_id = ? ORDER BY position ASC')
      .all(cardId) as Array<{ id: number; card_id: number; text: string; checked: number; position: number }>;

    const comments = this.db
      .prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC')
      .all(cardId) as KanbanComment[];

    const agents = this.db
      .prepare('SELECT * FROM kanban_card_agents WHERE card_id = ? ORDER BY assigned_at ASC')
      .all(cardId) as KanbanCardAgent[];

    const dependencies = this.db
      .prepare('SELECT * FROM kanban_card_dependencies WHERE card_id = ? ORDER BY id ASC')
      .all(cardId) as KanbanCardDependency[];

    // Compute blocked_by: depends_on cards NOT in 'done'
    const blockerIds = dependencies.map(d => d.depends_on_id);
    const blocked_by: number[] = [];
    for (const depId of blockerIds) {
      const dep = this.db
        .prepare(`SELECT "column" FROM kanban_cards WHERE id = ?`)
        .get(depId) as { column: string } | undefined;
      if (dep && dep.column !== 'done') blocked_by.push(depId);
    }

    return {
      ...card,
      checklist: checklist.map(c => ({ ...c, checked: c.checked === 1 })),
      comments,
      agents,
      dependencies,
      blocked_by,
    };
  }

  listKanbanCards(sessionId: number, opts?: { column?: KanbanColumn }): KanbanCard[] {
    // Active cards only — archived cards are exposed via listArchivedKanbanCards.
    if (opts?.column) {
      return this.db
        .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? AND "column" = ? AND archive_id IS NULL ORDER BY position ASC`)
        .all(sessionId, opts.column) as KanbanCard[];
    }
    return this.db
      .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? AND archive_id IS NULL ORDER BY "column" ASC, position ASC`)
      .all(sessionId) as KanbanCard[];
  }

  listArchivedKanbanCards(archiveId: number): KanbanCard[] {
    return this.db
      .prepare(`SELECT * FROM kanban_cards WHERE archive_id = ? ORDER BY "column" ASC, position ASC`)
      .all(archiveId) as KanbanCard[];
  }

  listKanbanCardsFull(sessionId: number): KanbanCardFull[] {
    const cards = this.listKanbanCards(sessionId);
    return cards.map(c => this.getKanbanCardFull(c.id)!);
  }

  moveKanbanCard(cardId: number, toColumn: KanbanColumn, toPosition?: number): KanbanCard {
    const move = this.db.transaction(() => {
      const card = this.getKanbanCard(cardId);
      if (!card) throw new Error(`Card ${cardId} not found`);

      const fromColumn = card.column;
      const fromPosition = card.position;

      // Remove from old column: shift down positions above
      if (fromColumn === toColumn) {
        // Same column reorder
        const targetPos = toPosition ?? card.position;
        if (targetPos === fromPosition) {
          // Update timestamp only
          this.db.prepare(`UPDATE kanban_cards SET updated_at = datetime('now') WHERE id = ?`).run(cardId);
          return this.getKanbanCard(cardId)!;
        }
        // Remove from old position
        this.db.prepare(`
          UPDATE kanban_cards SET position = position - 1
          WHERE company_session_id = ? AND "column" = ? AND position > ?
        `).run(card.company_session_id, fromColumn, fromPosition);
        // Make room at new position
        this.db.prepare(`
          UPDATE kanban_cards SET position = position + 1
          WHERE company_session_id = ? AND "column" = ? AND position >= ?
        `).run(card.company_session_id, toColumn, targetPos);
        // Place card
        this.db.prepare(`
          UPDATE kanban_cards SET position = ?, updated_at = datetime('now') WHERE id = ?
        `).run(targetPos, cardId);
      } else {
        // Cross-column move
        // Close gap in source column
        this.db.prepare(`
          UPDATE kanban_cards SET position = position - 1
          WHERE company_session_id = ? AND "column" = ? AND position > ?
        `).run(card.company_session_id, fromColumn, fromPosition);

        // Determine target position
        let targetPos: number;
        if (toPosition !== undefined) {
          targetPos = toPosition;
        } else {
          const maxPos = this.db.prepare(
            `SELECT COALESCE(MAX(position), -1) as m FROM kanban_cards WHERE company_session_id = ? AND "column" = ?`
          ).get(card.company_session_id, toColumn) as { m: number };
          targetPos = maxPos.m + 1;
        }

        // Make room at target position
        this.db.prepare(`
          UPDATE kanban_cards SET position = position + 1
          WHERE company_session_id = ? AND "column" = ? AND position >= ?
        `).run(card.company_session_id, toColumn, targetPos);

        // Move card
        this.db.prepare(`
          UPDATE kanban_cards SET "column" = ?, position = ?, updated_at = datetime('now') WHERE id = ?
        `).run(toColumn, targetPos, cardId);
      }

      return this.getKanbanCard(cardId)!;
    });

    return move();
  }

  updateKanbanCard(cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
    if (patch.tag !== undefined) { sets.push('tag = ?'); params.push(patch.tag); }
    if (sets.length === 0) return this.getKanbanCard(cardId);
    sets.push("updated_at = datetime('now')");
    params.push(cardId);
    this.db.prepare(`UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getKanbanCard(cardId);
  }

  deleteKanbanCard(cardId: number): boolean {
    const r = this.db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId);
    return r.changes > 0;
  }

  // ─── Kanban Checklist ─────────────────────────────────────────

  addChecklistItem(cardId: number, text: string, position?: number): KanbanChecklistItem {
    const pos = position ?? (() => {
      const m = this.db.prepare(
        `SELECT COALESCE(MAX(position), -1) as m FROM kanban_checklist_items WHERE card_id = ?`
      ).get(cardId) as { m: number };
      return m.m + 1;
    })();
    const r = this.db.prepare(`
      INSERT INTO kanban_checklist_items (card_id, text, position) VALUES (?, ?, ?)
    `).run(cardId, text, pos);
    const row = this.db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as { id: number; card_id: number; text: string; checked: number; position: number };
    return { ...row, checked: row.checked === 1 };
  }

  updateChecklistItem(itemId: number, patch: { text?: string; checked?: boolean; position?: number }): KanbanChecklistItem | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.text !== undefined) { sets.push('text = ?'); params.push(patch.text); }
    if (patch.checked !== undefined) { sets.push('checked = ?'); params.push(patch.checked ? 1 : 0); }
    if (patch.position !== undefined) { sets.push('position = ?'); params.push(patch.position); }
    if (sets.length === 0) {
      const row = this.db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as { id: number; card_id: number; text: string; checked: number; position: number } | undefined;
      return row ? { ...row, checked: row.checked === 1 } : null;
    }
    params.push(itemId);
    this.db.prepare(`UPDATE kanban_checklist_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    const row = this.db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as { id: number; card_id: number; text: string; checked: number; position: number } | undefined;
    return row ? { ...row, checked: row.checked === 1 } : null;
  }

  removeChecklistItem(itemId: number): boolean {
    const r = this.db.prepare('DELETE FROM kanban_checklist_items WHERE id = ?').run(itemId);
    return r.changes > 0;
  }

  getChecklistItem(itemId: number): KanbanChecklistItem | null {
    const row = this.db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as
      | { id: number; card_id: number; text: string; checked: number; position: number }
      | undefined;
    return row ? { ...row, checked: row.checked === 1 } : null;
  }

  // ─── Kanban Comments ──────────────────────────────────────────

  addKanbanComment(cardId: number, authorRole: string, agentRunId: number | null, content: string): KanbanComment {
    const r = this.db.prepare(`
      INSERT INTO kanban_comments (card_id, author_role, agent_run_id, content)
      VALUES (?, ?, ?, ?)
    `).run(cardId, authorRole, agentRunId, content);
    return this.db.prepare('SELECT * FROM kanban_comments WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as KanbanComment;
  }

  listKanbanComments(cardId: number): KanbanComment[] {
    return this.db
      .prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC')
      .all(cardId) as KanbanComment[];
  }

  // ─── Kanban Agent Assignment ──────────────────────────────────

  assignAgentToCard(cardId: number, agentRunId: number, role: string): KanbanCardAgent {
    const r = this.db.prepare(`
      INSERT INTO kanban_card_agents (card_id, agent_run_id, role)
      VALUES (?, ?, ?)
    `).run(cardId, agentRunId, role);
    return this.db.prepare('SELECT * FROM kanban_card_agents WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as KanbanCardAgent;
  }

  unassignAgentFromCard(cardId: number, agentRunId: number): void {
    this.db.prepare(`
      UPDATE kanban_card_agents SET unassigned_at = datetime('now')
      WHERE card_id = ? AND agent_run_id = ? AND unassigned_at IS NULL
    `).run(cardId, agentRunId);
  }

  findCardByAgentRun(agentRunId: number): KanbanCard | null {
    const assignment = this.db.prepare(`
      SELECT card_id FROM kanban_card_agents
      WHERE agent_run_id = ? AND unassigned_at IS NULL
      ORDER BY assigned_at DESC LIMIT 1
    `).get(agentRunId) as { card_id: number } | undefined;
    if (!assignment) return null;
    return this.getKanbanCard(assignment.card_id);
  }

  // ─── Kanban Dependencies ──────────────────────────────────────

  addCardDependency(cardId: number, dependsOnId: number): KanbanCardDependency {
    // Check circular dependency via recursive CTE
    const cycle = this.db.prepare(`
      WITH RECURSIVE chain(id) AS (
        SELECT card_id FROM kanban_card_dependencies WHERE depends_on_id = ?
        UNION
        SELECT kd.card_id FROM kanban_card_dependencies kd JOIN chain c ON kd.depends_on_id = c.id
      )
      SELECT 1 FROM chain WHERE id = ? LIMIT 1
    `).get(cardId, dependsOnId) as { '1': number } | undefined;

    if (cycle) throw new Error(`Adding dependency would create a cycle: card ${dependsOnId} already depends (transitively) on card ${cardId}`);

    const r = this.db.prepare(`
      INSERT INTO kanban_card_dependencies (card_id, depends_on_id)
      VALUES (?, ?)
    `).run(cardId, dependsOnId);
    return this.db.prepare('SELECT * FROM kanban_card_dependencies WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as KanbanCardDependency;
  }

  removeCardDependency(cardId: number, dependsOnId: number): boolean {
    const r = this.db.prepare(
      'DELETE FROM kanban_card_dependencies WHERE card_id = ? AND depends_on_id = ?'
    ).run(cardId, dependsOnId);
    return r.changes > 0;
  }

  /** Cards that have unresolved blockers (dependencies not in 'done'). */
  getBlockedCards(sessionId: number): KanbanCard[] {
    return this.db.prepare(`
      SELECT DISTINCT c.* FROM kanban_cards c
      JOIN kanban_card_dependencies d ON d.card_id = c.id
      JOIN kanban_cards blocker ON blocker.id = d.depends_on_id AND blocker."column" != 'done'
      WHERE c.company_session_id = ?
    `).all(sessionId) as KanbanCard[];
  }

  // ─── Session Archives (Reset) ──────────────────────────────────

  /**
   * Archive all currently-active conversation state for a session and
   * flip it back to `idle`. After this call:
   *   - `listAgentRuns`, `readBoard`, `listMasterPrompts` return empty
   *     (the rows still exist but carry `archive_id` now).
   *   - If `opts.includeKanban`, kanban_cards are archived too.
   *   - Any agent_runs that were `running`/`waiting*`/`working` are
   *     forced to `aborted` BEFORE stamping so the archive shows the
   *     real outcome.
   *   - Session status → `idle`, `master_session_id` cleared, so the
   *     next `/start` creates a fresh master.
   * The orchestrator eviction and sandbox teardown are done by the
   * HTTP handler (see archives.ts); this method only touches the DB.
   */
  archiveCompanySession(
    companySessionId: number,
    opts: { reason?: string; includeKanban: boolean; includeSandbox: boolean },
  ): CompanySessionArchive {
    const tx = this.db.transaction(() => {
      // 1. Create archive row.
      const insert = this.db.prepare(`
        INSERT INTO company_session_archives
          (company_session_id, reason, included_kanban, included_sandbox, stats_json)
        VALUES (?, ?, ?, ?, '{}')
      `);
      const r = insert.run(
        companySessionId,
        opts.reason ?? null,
        opts.includeKanban ? 1 : 0,
        opts.includeSandbox ? 1 : 0,
      );
      const archiveId = Number(r.lastInsertRowid);

      // 2. Force still-live agent runs to 'aborted' first so the
      //    archived snapshot reflects reality, not an impossible
      //    "running" state for rows whose runner is already gone.
      this.db.prepare(`
        UPDATE company_agent_runs
           SET status = 'aborted',
               status_message = COALESCE(status_message, '') || ' [aborted by session reset]',
               updated_at = datetime('now')
         WHERE company_session_id = ?
           AND archive_id IS NULL
           AND status IN ('running','working','waiting','waiting_plan','waiting_question','waiting_tasks','reviewing','blocked','idle')
      `).run(companySessionId);

      // 3. Stamp archive_id on every active row that belongs to this
      //    session's conversation state. ORDER of updates matters only
      //    for referential clarity — all rows are independent.
      const agentRunsCount = this.db.prepare(`
        UPDATE company_agent_runs SET archive_id = ?
        WHERE company_session_id = ? AND archive_id IS NULL
      `).run(archiveId, companySessionId).changes;

      const boardCount = this.db.prepare(`
        UPDATE company_board SET archive_id = ?
        WHERE company_session_id = ? AND archive_id IS NULL
      `).run(archiveId, companySessionId).changes;

      const masterPromptCount = this.db.prepare(`
        UPDATE company_master_prompts SET archive_id = ?
        WHERE company_session_id = ? AND archive_id IS NULL
      `).run(archiveId, companySessionId).changes;

      const kanbanCount = opts.includeKanban
        ? this.db.prepare(`
            UPDATE kanban_cards SET archive_id = ?
            WHERE company_session_id = ? AND archive_id IS NULL
          `).run(archiveId, companySessionId).changes
        : 0;

      // 4. Reset session to idle. For PARENT sessions this is "reset
      //    flow" — the row stays visible in the sidebar so the user
      //    can `/start` it again. For CHILD sessions (fronts) we ALSO
      //    stamp `archived_at` so `listChildSessions` stops returning
      //    it — otherwise an "archived" front re-appears the next
      //    time the dashboard loads (migration 087).
      this.db.prepare(`
        UPDATE company_sessions
           SET status = 'idle',
               master_session_id = NULL,
               archived_at = CASE WHEN parent_session_id IS NULL THEN archived_at ELSE datetime('now') END,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(companySessionId);

      // 5. Cache stats so the list endpoint is cheap.
      const stats = {
        agent_runs: agentRunsCount,
        board_entries: boardCount,
        master_prompts: masterPromptCount,
        kanban_cards: kanbanCount,
      };
      this.db.prepare(`
        UPDATE company_session_archives SET stats_json = ? WHERE id = ?
      `).run(JSON.stringify(stats), archiveId);

      return this.getArchive(archiveId)!;
    });
    return tx();
  }

  getArchive(id: number): CompanySessionArchive | null {
    const row = this.db
      .prepare('SELECT * FROM company_session_archives WHERE id = ?')
      .get(id) as
      | {
          id: number;
          company_session_id: number;
          archived_at: string;
          reason: string | null;
          included_kanban: number;
          included_sandbox: number;
          stats_json: string;
        }
      | undefined;
    if (!row) return null;
    return mapArchiveRow(row);
  }

  listArchives(companySessionId: number): CompanySessionArchive[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM company_session_archives WHERE company_session_id = ? ORDER BY archived_at DESC, id DESC',
      )
      .all(companySessionId) as Array<{
        id: number;
        company_session_id: number;
        archived_at: string;
        reason: string | null;
        included_kanban: number;
        included_sandbox: number;
        stats_json: string;
      }>;
    return rows.map(mapArchiveRow);
  }

  // ─── QA verdict (read-only helper used by the pipeline executor) ──

  /**
   * Pass/fail verdict for the most recent COMPLETED QA run scoped to a
   * given Kanban feature card. The pipeline executor consults this for
   * `pass-fail` branches so it can rely on real test counts instead of
   * parsing prose. Returns `null` when there is no completed run.
   */
  getLatestQaVerdictForCard(companySessionId: number, cardId: number): 'pass' | 'fail' | null {
    const row = this.db
      .prepare(
        `SELECT passed, failed FROM qa_test_runs
         WHERE company_session_id = ? AND kanban_feature_card_id = ? AND status = 'completed'
         ORDER BY datetime(started_at) DESC, id DESC
         LIMIT 1`,
      )
      .get(companySessionId, cardId) as { passed: number; failed: number } | undefined;
    if (!row) return null;
    if (row.failed > 0) return 'fail';
    if (row.passed > 0) return 'pass';
    return null;
  }

  // ─── Pipelines ─────────────────────────────────────────────────

  createPipeline(input: {
    name: string;
    description?: string;
    graph: PipelineGraph;
    companySessionId?: number | null;
    templateId?: number | null;
  }): Pipeline {
    const stmt = this.db.prepare(`
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
    return this.getPipeline(Number(r.lastInsertRowid))!;
  }

  getPipeline(id: number): Pipeline | null {
    const row = this.db
      .prepare('SELECT * FROM pipelines WHERE id = ?')
      .get(id) as PipelineRow | undefined;
    return row ? mapPipelineRow(row) : null;
  }

  listPipelines(opts?: {
    companySessionId?: number | null;
    templateId?: number | null;
    /**
     * Chat-mode filter: list pipelines that are EITHER global
     * (`company_session_id IS NULL`) OR bound to a company session
     * that includes this project. Joins through
     * `company_session_projects`. Mutually exclusive with
     * `companySessionId` — the orchestrator path always passes the
     * latter; the chat path passes this.
     */
    projectIdForChat?: number;
  }): Pipeline[] {
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
    const rows = this.db.prepare(sql).all(...params) as PipelineRow[];
    return rows.map(mapPipelineRow);
  }

  /**
   * Updates a pipeline. When `expectedVersion` is provided and does not
   * match the current row, throws `PipelineVersionMismatch` so the route
   * layer can return 409 to the client. Successful writes bump `version`.
   */
  updatePipeline(
    id: number,
    patch: { name?: string; description?: string; graph?: PipelineGraph },
    opts?: { expectedVersion?: number },
  ): Pipeline | null {
    const cur = this.getPipeline(id);
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
    this.db.prepare(`UPDATE pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getPipeline(id);
  }

  deletePipeline(id: number): boolean {
    const r = this.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Pipeline executions ──────────────────────────────────────

  /**
   * Exactly one of `companySessionId` / `coderSessionId` must be set —
   * the DB-level CHECK in migration 077 enforces this. Company-path
   * callers continue to pass `companySessionId`; chat-path callers
   * pass `coderSessionId` and leave the other null.
   */
  createPipelineExecution(input: {
    pipelineId: number;
    companySessionId?: number | null;
    coderSessionId?: number | null;
    initialInput: string;
    context: PipelineExecutionContext;
    startedBy?: string;
    currentNodeId?: string | null;
  }): PipelineExecution {
    const companyId = input.companySessionId ?? null;
    const coderId = input.coderSessionId ?? null;
    if ((companyId == null) === (coderId == null)) {
      throw new Error(
        'createPipelineExecution: exactly one of companySessionId / coderSessionId must be set',
      );
    }
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_executions
        (pipeline_id, company_session_id, coder_session_id, status, current_node_id,
         initial_input, context_json, started_by)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
    `);
    const r = stmt.run(
      input.pipelineId,
      companyId,
      coderId,
      input.currentNodeId ?? null,
      input.initialInput,
      JSON.stringify(input.context),
      input.startedBy ?? 'master',
    );
    return this.getPipelineExecution(Number(r.lastInsertRowid))!;
  }

  getPipelineExecution(id: number): PipelineExecution | null {
    const row = this.db
      .prepare('SELECT * FROM pipeline_executions WHERE id = ?')
      .get(id) as PipelineExecutionRow | undefined;
    return row ? mapPipelineExecutionRow(row) : null;
  }

  listPipelineExecutions(opts: {
    companySessionId?: number;
    coderSessionId?: number;
    pipelineId?: number;
    status?: PipelineExecutionStatus;
    limit?: number;
  }): PipelineExecution[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (typeof opts.companySessionId === 'number') {
      where.push('company_session_id = ?');
      params.push(opts.companySessionId);
    }
    if (typeof opts.coderSessionId === 'number') {
      where.push('coder_session_id = ?');
      params.push(opts.coderSessionId);
    }
    if (typeof opts.pipelineId === 'number') {
      where.push('pipeline_id = ?');
      params.push(opts.pipelineId);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    let sql = `SELECT * FROM pipeline_executions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC, id DESC`;
    if (typeof opts.limit === 'number') sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
    const rows = this.db.prepare(sql).all(...params) as PipelineExecutionRow[];
    return rows.map(mapPipelineExecutionRow);
  }

  updatePipelineExecution(
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
    if (sets.length === 0) return this.getPipelineExecution(id);
    params.push(id);
    this.db.prepare(`UPDATE pipeline_executions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getPipelineExecution(id);
  }

  // ─── Pipeline node executions ─────────────────────────────────

  createPipelineNodeExecution(input: {
    executionId: number;
    nodeId: string;
    nodeLabel: string;
    role: string;
    inputText: string;
    attempt?: number;
    agentRunId?: number | null;
    kanbanCardId?: number | null;
    coderSessionId?: number | null;
  }): PipelineNodeExecution {
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_node_executions
        (execution_id, node_id, node_label, role, status, agent_run_id, kanban_card_id,
         coder_session_id, input_text, attempt, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, datetime('now'))
    `);
    const r = stmt.run(
      input.executionId,
      input.nodeId,
      input.nodeLabel,
      input.role,
      input.agentRunId ?? null,
      input.kanbanCardId ?? null,
      input.coderSessionId ?? null,
      input.inputText,
      input.attempt ?? 1,
    );
    return this.getPipelineNodeExecution(Number(r.lastInsertRowid))!;
  }

  getPipelineNodeExecution(id: number): PipelineNodeExecution | null {
    const row = this.db
      .prepare('SELECT * FROM pipeline_node_executions WHERE id = ?')
      .get(id) as PipelineNodeExecutionRow | undefined;
    return row ? mapPipelineNodeExecutionRow(row) : null;
  }

  listPipelineNodeExecutions(executionId: number): PipelineNodeExecution[] {
    const rows = this.db
      .prepare('SELECT * FROM pipeline_node_executions WHERE execution_id = ? ORDER BY created_at ASC, id ASC')
      .all(executionId) as PipelineNodeExecutionRow[];
    return rows.map(mapPipelineNodeExecutionRow);
  }

  updatePipelineNodeExecution(
    id: number,
    patch: {
      status?: PipelineNodeStatus;
      agentRunId?: number | null;
      kanbanCardId?: number | null;
      coderSessionId?: number | null;
      outputText?: string | null;
      outcomeBranch?: string | null;
      finishedAt?: string | null;
      errorMessage?: string | null;
      usageJson?: string | null;
    },
  ): PipelineNodeExecution | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
    if (patch.agentRunId !== undefined) { sets.push('agent_run_id = ?'); params.push(patch.agentRunId); }
    if (patch.kanbanCardId !== undefined) { sets.push('kanban_card_id = ?'); params.push(patch.kanbanCardId); }
    if (patch.coderSessionId !== undefined) { sets.push('coder_session_id = ?'); params.push(patch.coderSessionId); }
    if (patch.outputText !== undefined) { sets.push('output_text = ?'); params.push(patch.outputText); }
    if (patch.outcomeBranch !== undefined) { sets.push('outcome_branch = ?'); params.push(patch.outcomeBranch); }
    if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt); }
    if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); params.push(patch.errorMessage); }
    if (patch.usageJson !== undefined) { sets.push('usage_json = ?'); params.push(patch.usageJson); }
    if (sets.length === 0) return this.getPipelineNodeExecution(id);
    params.push(id);
    this.db.prepare(`UPDATE pipeline_node_executions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.getPipelineNodeExecution(id);
  }

  // ─── Agent inbox ───────────────────────────────────────────────

  createInboxMessage(input: {
    companySessionId: number;
    fromAgentRunId: number;
    fromRole: string;
    toRole?: string | null;
    toAgentRunId?: number | null;
    kind: InboxKind;
    body: string;
    waitToken?: string | null;
  }): AgentInboxMessage {
    const stmt = this.db.prepare(`
      INSERT INTO agent_inbox
        (company_session_id, from_agent_run_id, from_role, to_role, to_agent_run_id, kind, body, wait_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      input.companySessionId,
      input.fromAgentRunId,
      input.fromRole,
      input.toRole ?? null,
      input.toAgentRunId ?? null,
      input.kind,
      input.body,
      input.waitToken ?? null,
    );
    const msg = this.getInboxMessage(Number(r.lastInsertRowid))!;
    return msg;
  }

  getInboxMessage(id: number): AgentInboxMessage | null {
    const row = this.db
      .prepare('SELECT * FROM agent_inbox WHERE id = ?')
      .get(id) as InboxRow | undefined;
    return row ? mapInboxRow(row) : null;
  }

  /**
   * List messages scoped to a session. Filters narrow the result so the
   * dashboard inbox panel and the cycle detector can both reuse the
   * same path. Ordered oldest-first so callers picking "the next one"
   * get FIFO semantics.
   */
  listInboxMessages(opts: {
    companySessionId: number;
    status?: InboxStatus | InboxStatus[];
    toRole?: string;
    toAgentRunId?: number;
    fromAgentRunId?: number;
    limit?: number;
  }): AgentInboxMessage[] {
    const where: string[] = ['company_session_id = ?'];
    const params: unknown[] = [opts.companySessionId];
    if (opts.status) {
      const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${arr.map(() => '?').join(',')})`);
      for (const s of arr) params.push(s);
    }
    if (opts.toRole) { where.push('to_role = ?'); params.push(opts.toRole); }
    if (typeof opts.toAgentRunId === 'number') { where.push('to_agent_run_id = ?'); params.push(opts.toAgentRunId); }
    if (typeof opts.fromAgentRunId === 'number') { where.push('from_agent_run_id = ?'); params.push(opts.fromAgentRunId); }
    let sql = `SELECT * FROM agent_inbox WHERE ${where.join(' AND ')} ORDER BY datetime(created_at) ASC, id ASC`;
    if (typeof opts.limit === 'number') sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
    const rows = this.db.prepare(sql).all(...params) as InboxRow[];
    return rows.map(mapInboxRow);
  }

  /**
   * Atomically claim the next pending message for `(toAgentRunId OR
   * toRole)` and flip it to `delivered`. Returns the claimed message
   * or null if there's nothing waiting. The conditional UPDATE
   * protects against two competing drains racing on the same row.
   */
  claimNextInboxForAgent(args: {
    companySessionId: number;
    agentRunId: number;
    role: string;
  }): AgentInboxMessage | null {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM agent_inbox
         WHERE company_session_id = ?
           AND status = 'pending'
           AND (to_agent_run_id = ? OR (to_agent_run_id IS NULL AND to_role = ?))
         ORDER BY datetime(created_at) ASC, id ASC
         LIMIT 1`,
      ).get(args.companySessionId, args.agentRunId, args.role) as InboxRow | undefined;
      if (!row) return null;
      const result = this.db.prepare(
        `UPDATE agent_inbox
         SET status = 'delivered', delivered_at = datetime('now'), to_agent_run_id = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(args.agentRunId, row.id);
      if (result.changes === 0) return null;
      return this.getInboxMessage(row.id);
    });
    return tx();
  }

  answerInboxMessage(id: number, answer: string): AgentInboxMessage | null {
    const r = this.db.prepare(
      `UPDATE agent_inbox SET status = 'answered', answer = ?, answered_at = datetime('now')
       WHERE id = ? AND status IN ('pending','delivered')`,
    ).run(answer, id);
    if (r.changes === 0) return null;
    return this.getInboxMessage(id);
  }

  /**
   * Generic status flip. Used for `cancelled` / `expired` paths so the
   * routes/queue don't have to format their own SQL.
   */
  setInboxStatus(id: number, status: InboxStatus, opts?: { answer?: string }): AgentInboxMessage | null {
    const sets: string[] = ['status = ?'];
    const params: unknown[] = [status];
    if (status === 'answered' || status === 'expired' || status === 'cancelled') {
      sets.push("answered_at = COALESCE(answered_at, datetime('now'))");
    }
    if (opts?.answer != null) { sets.push('answer = ?'); params.push(opts.answer); }
    params.push(id);
    const r = this.db.prepare(
      `UPDATE agent_inbox SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);
    if (r.changes === 0) return null;
    return this.getInboxMessage(id);
  }
}

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
  try {
    graph = JSON.parse(row.graph_json) as PipelineGraph;
  } catch {
    graph = { version: 1, nodes: [], edges: [] };
  }
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

interface PipelineExecutionRow {
  id: number;
  pipeline_id: number;
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

function mapPipelineExecutionRow(row: PipelineExecutionRow): PipelineExecution {
  let context: PipelineExecutionContext = {
    snapshot: { version: 1, nodes: [], edges: [] },
    vars: {},
  };
  try {
    const parsed = JSON.parse(row.context_json) as Partial<PipelineExecutionContext>;
    if (parsed.snapshot) context.snapshot = parsed.snapshot;
    if (parsed.vars) context.vars = parsed.vars;
  } catch {
    // fall back to empty
  }
  return {
    id: row.id,
    pipeline_id: row.pipeline_id,
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

interface PipelineNodeExecutionRow {
  id: number;
  execution_id: number;
  node_id: string;
  node_label: string;
  role: string;
  status: string;
  agent_run_id: number | null;
  kanban_card_id: number | null;
  coder_session_id: number | null;
  input_text: string;
  output_text: string | null;
  outcome_branch: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  usage_json: string | null;
  created_at: string;
}

function mapPipelineNodeExecutionRow(row: PipelineNodeExecutionRow): PipelineNodeExecution {
  return {
    id: row.id,
    execution_id: row.execution_id,
    node_id: row.node_id,
    node_label: row.node_label,
    role: row.role,
    status: row.status as PipelineNodeStatus,
    agent_run_id: row.agent_run_id,
    kanban_card_id: row.kanban_card_id,
    coder_session_id: row.coder_session_id,
    input_text: row.input_text,
    output_text: row.output_text,
    outcome_branch: row.outcome_branch,
    attempt: row.attempt,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error_message: row.error_message,
    usage_json: row.usage_json,
  };
}

interface InboxRow {
  id: number;
  company_session_id: number;
  from_agent_run_id: number;
  from_role: string;
  to_role: string | null;
  to_agent_run_id: number | null;
  kind: string;
  body: string;
  status: string;
  answer: string | null;
  wait_token: string | null;
  created_at: string;
  delivered_at: string | null;
  answered_at: string | null;
}

function mapInboxRow(row: InboxRow): AgentInboxMessage {
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    from_agent_run_id: row.from_agent_run_id,
    from_role: row.from_role,
    to_role: row.to_role,
    to_agent_run_id: row.to_agent_run_id,
    kind: row.kind as InboxKind,
    body: row.body,
    status: row.status as InboxStatus,
    answer: row.answer,
    wait_token: row.wait_token,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    answered_at: row.answered_at,
  };
}

function mapArchiveRow(row: {
  id: number;
  company_session_id: number;
  archived_at: string;
  reason: string | null;
  included_kanban: number;
  included_sandbox: number;
  stats_json: string;
}): CompanySessionArchive {
  let stats = { agent_runs: 0, board_entries: 0, master_prompts: 0, kanban_cards: 0 };
  try {
    const parsed = JSON.parse(row.stats_json);
    stats = { ...stats, ...parsed };
  } catch {
    // fall back to zeros
  }
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    archived_at: row.archived_at,
    reason: row.reason,
    included_kanban: row.included_kanban === 1,
    included_sandbox: row.included_sandbox === 1,
    stats,
  };
}
