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
    const companySessions = this.db.prepare(`
      UPDATE company_sessions
      SET status = 'paused',
          updated_at = datetime('now')
      WHERE status = 'running'
    `).run().changes;
    return { agentRuns, companySessions };
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
    const stmt = this.db.prepare(`
      UPDATE company_master_prompts
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE company_session_id = ? AND status = 'pending'
    `);
    stmt.run(companySessionId);
    // Re-read to get fresh resolved_at.
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
    return this.getKanbanCard(Number(r.lastInsertRowid))!;
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

      // 4. Reset session to idle so /start can be called again. Keep
      //    `template_id`, `config_json`, projects, sandboxes untouched.
      this.db.prepare(`
        UPDATE company_sessions
           SET status = 'idle',
               master_session_id = NULL,
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
