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
    const whereClause = clauses.join(' AND ');
    // With sinceId: fetch next N entries after that point (ASC is correct).
    // Without sinceId: fetch the LATEST N entries via DESC subquery, re-sorted ASC.
    const sql = opts?.sinceId != null
      ? `SELECT * FROM company_board WHERE ${whereClause} ORDER BY id ASC LIMIT ?`
      : `SELECT * FROM (SELECT * FROM company_board WHERE ${whereClause} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(...params) as BoardRow[];
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
    if (opts?.column) {
      return this.db
        .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? AND "column" = ? ORDER BY position ASC`)
        .all(sessionId, opts.column) as KanbanCard[];
    }
    return this.db
      .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? ORDER BY "column" ASC, position ASC`)
      .all(sessionId) as KanbanCard[];
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
}
