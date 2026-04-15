import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentMessage } from '../core/messages.js';
import type {
  CoderSession, CoderSessionGroup, CoderMessageRow, SessionWithMessages, CoderSessionStats, CoderPlanRow, CoderPlanStatus,
  CoderTask, TasksState, CoderTasksRow, TaskExecutionMode, RecentCoderSession,
} from './types.js';

type SessionRow = Omit<CoderSession, 'is_archived' | 'is_favorite'> & {
  is_archived: number;
  is_favorite: number;
};

function mapSessionRow(row: SessionRow | undefined | null): CoderSession | null {
  if (!row) return null;
  return {
    ...row,
    is_archived: !!row.is_archived,
    is_favorite: !!row.is_favorite,
  } as CoderSession;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

/**
 * SessionStore wraps the SQLite tables added by migration 004.
 *
 * Schema is owned by the migration; this class only does CRUD. The runner
 * persists each turn (assistant message + tool calls + tool results) atomically
 * via persistAssistantTurn / persistUserMessage / persistToolResults.
 */
export class SessionStore {
  private db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  close(): void {
    this.db.close();
  }

  // ─── Sessions ─────────────────────────────────────────────────

  createSession(input: {
    project_id: number;
    title: string;
    provider: string;
    model: string;
    cloudcode_session_id?: string;
  }): CoderSession {
    const stmt = this.db.prepare(`
      INSERT INTO coder_sessions (project_id, title, provider, model, cloudcode_session_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      input.project_id, input.title, input.provider, input.model,
      input.cloudcode_session_id ?? null,
    );
    return this.getSession(Number(r.lastInsertRowid))!;
  }

  getSession(id: number): CoderSession | null {
    const row = this.db
      .prepare('SELECT * FROM coder_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return mapSessionRow(row);
  }

  /**
   * List sessions for a project. By default returns only non-archived sessions.
   * Pass `{ archived: true }` to get the archived tab, or `{ archived: null }`
   * to get everything regardless of archive state.
   */
  listSessions(
    projectId: number,
    opts: { archived?: boolean | null; groupId?: number | null } = {}
  ): CoderSession[] {
    const clauses: string[] = ['project_id = ?'];
    const params: (number | string)[] = [projectId];

    const archived = opts.archived === undefined ? false : opts.archived;
    if (archived !== null) {
      clauses.push('is_archived = ?');
      params.push(archived ? 1 : 0);
    }
    if (opts.groupId !== undefined) {
      if (opts.groupId === null) {
        clauses.push('group_id IS NULL');
      } else {
        clauses.push('group_id = ?');
        params.push(opts.groupId);
      }
    }

    const sql = `SELECT * FROM coder_sessions WHERE ${clauses.join(' AND ')} ORDER BY is_favorite DESC, updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as SessionRow[];
    return rows.map((r) => mapSessionRow(r)!);
  }

  /**
   * Cross-project recent sessions for the global sidebar. Joins projects
   * to enrich each row with the project name so the sidebar can render the
   * breadcrumb + navigate on click.
   */
  listRecentSessionsGlobal(limit = 10): RecentCoderSession[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, p.name AS project_name
           FROM coder_sessions s
           JOIN projects p ON p.id = s.project_id
          WHERE s.is_archived = 0
          ORDER BY s.is_favorite DESC, s.updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<SessionRow & { project_name: string }>;
    return rows.map((r) => {
      const mapped = mapSessionRow(r)!;
      return { ...mapped, project_name: r.project_name };
    });
  }

  deleteSession(id: number): void {
    this.db.prepare('DELETE FROM coder_sessions WHERE id = ?').run(id);
  }

  /** Atomic batch delete — all-or-nothing. Returns the number of rows removed. */
  deleteSessionsBatch(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM coder_sessions WHERE id IN (${placeholders})`);
    const tx = this.db.transaction((xs: number[]) => stmt.run(...xs));
    const r = tx(ids);
    return r.changes ?? 0;
  }

  setSessionArchived(id: number, archived: boolean): void {
    this.db
      .prepare(`
        UPDATE coder_sessions
           SET is_archived = ?,
               archived_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
               updated_at = updated_at
         WHERE id = ?
      `)
      .run(archived ? 1 : 0, archived ? 1 : 0, id);
  }

  setSessionFavorite(id: number, favorite: boolean): void {
    this.db
      .prepare(`
        UPDATE coder_sessions
           SET is_favorite = ?,
               favorited_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
         WHERE id = ?
      `)
      .run(favorite ? 1 : 0, favorite ? 1 : 0, id);
  }

  setSessionGroup(id: number, groupId: number | null): void {
    this.db
      .prepare('UPDATE coder_sessions SET group_id = ? WHERE id = ?')
      .run(groupId, id);
  }

  /**
   * Replace the serialized lightweight todo list for a session. Called by
   * the runCoder wiring in response to the runner's `todos_updated` event.
   * Pass null to clear.
   */
  setSessionTodos(id: number, todosJson: string | null): void {
    this.db
      .prepare('UPDATE coder_sessions SET todos_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(todosJson, id);
  }

  /**
   * Set or clear the worktree path for a session. Called by `enter_worktree`
   * (set) and `exit_worktree` (clear). Persisted so a session resume after a
   * server restart can restore the runner's cwd.
   */
  setSessionWorktree(id: number, worktreePath: string | null): void {
    this.db
      .prepare('UPDATE coder_sessions SET worktree_path = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(worktreePath, id);
  }

  /** Get existing cloudcode_session_id or generate + persist a new one. */
  getOrCreateCloudCodeSessionId(id: number): string {
    const row = this.db
      .prepare('SELECT cloudcode_session_id FROM coder_sessions WHERE id = ?')
      .get(id) as { cloudcode_session_id: string | null } | undefined;
    if (row?.cloudcode_session_id) return row.cloudcode_session_id;
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    const sid = randomUUID();
    this.db
      .prepare('UPDATE coder_sessions SET cloudcode_session_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(sid, id);
    return sid;
  }

  updateSessionStatus(id: number, status: CoderSession['status']): void {
    this.db
      .prepare('UPDATE coder_sessions SET status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(status, id);
  }

  updateSessionProvider(id: number, provider: string, model: string): void {
    this.db
      .prepare('UPDATE coder_sessions SET provider = ?, model = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(provider, model, id);
  }

  /** Get the per-session fallback provider/model override (if configured). */
  getSessionFallback(id: number): { provider: string; model: string } | null {
    const row = this.db
      .prepare('SELECT fallback_provider, fallback_model FROM coder_sessions WHERE id = ?')
      .get(id) as { fallback_provider: string | null; fallback_model: string | null } | undefined;
    if (!row || !row.fallback_provider || !row.fallback_model) return null;
    return { provider: row.fallback_provider, model: row.fallback_model };
  }

  /** Set or clear the per-session fallback provider/model override. */
  setSessionFallback(id: number, provider: string | null, model: string | null): void {
    this.db
      .prepare('UPDATE coder_sessions SET fallback_provider = ?, fallback_model = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(provider, model, id);
  }

  bumpUsage(
    id: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheCreationTokens: number = 0,
  ): void {
    this.db
      .prepare(`
        UPDATE coder_sessions
           SET total_input_tokens = total_input_tokens + ?,
               total_output_tokens = total_output_tokens + ?,
               total_cache_read_tokens = total_cache_read_tokens + ?,
               total_cache_creation_tokens = total_cache_creation_tokens + ?,
               updated_at = datetime('now')
         WHERE id = ?
      `)
      .run(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, id);
  }

  // ─── Messages ─────────────────────────────────────────────────

  appendMessage(
    sessionId: number,
    message: AgentMessage,
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO coder_messages
        (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      sessionId,
      message.role,
      JSON.stringify(message.content),
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
    );
    this.db
      .prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\') WHERE id = ?')
      .run(sessionId);
    return Number(r.lastInsertRowid);
  }

  /**
   * Aggregate metrics for a single session, computed in one round-trip via
   * a UNION of two queries: session totals + tool-call aggregates joined
   * through coder_messages.
   */
  getSessionStats(id: number): CoderSessionStats | null {
    const session = this.db
      .prepare(`
        SELECT
          total_input_tokens,
          total_output_tokens,
          total_cache_read_tokens,
          total_cache_creation_tokens,
          CAST((julianday(updated_at) - julianday(created_at)) * 86400000 AS INTEGER) AS duration_ms
        FROM coder_sessions
        WHERE id = ?
      `)
      .get(id) as
      | {
          total_input_tokens: number;
          total_output_tokens: number;
          total_cache_read_tokens: number;
          total_cache_creation_tokens: number;
          duration_ms: number;
        }
      | undefined;
    if (!session) return null;

    const messages = this.db
      .prepare(`
        SELECT
          COUNT(*) AS message_count,
          SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_turns
        FROM coder_messages
        WHERE session_id = ?
      `)
      .get(id) as { message_count: number; assistant_turns: number | null };

    const tools = this.db
      .prepare(`
        SELECT
          COUNT(*) AS tool_call_count,
          SUM(CASE WHEN tc.is_error = 1 THEN 1 ELSE 0 END) AS tool_error_count,
          COUNT(DISTINCT tc.tool_name) AS distinct_tools,
          SUM(CASE WHEN tc.tool_name = 'spawn_subagent' THEN 1 ELSE 0 END) AS subagent_call_count,
          COALESCE(SUM(tc.duration_ms), 0) AS total_tool_duration_ms
        FROM coder_tool_calls tc
        JOIN coder_messages m ON m.id = tc.message_id
        WHERE m.session_id = ?
      `)
      .get(id) as {
        tool_call_count: number;
        tool_error_count: number | null;
        distinct_tools: number;
        subagent_call_count: number | null;
        total_tool_duration_ms: number;
      };

    return {
      total_input_tokens: session.total_input_tokens,
      total_output_tokens: session.total_output_tokens,
      total_cache_read_tokens: session.total_cache_read_tokens,
      total_cache_creation_tokens: session.total_cache_creation_tokens,
      message_count: messages.message_count ?? 0,
      assistant_turns: messages.assistant_turns ?? 0,
      tool_call_count: tools.tool_call_count ?? 0,
      tool_error_count: tools.tool_error_count ?? 0,
      distinct_tools: tools.distinct_tools ?? 0,
      subagent_call_count: tools.subagent_call_count ?? 0,
      total_tool_duration_ms: tools.total_tool_duration_ms ?? 0,
      duration_ms: session.duration_ms ?? 0,
    };
  }

  appendToolCall(input: {
    message_id: number;
    tool_use_id: string;
    tool_name: string;
    args: Record<string, unknown>;
    result_text: string;
    is_error: boolean;
    duration_ms: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO coder_tool_calls
          (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.message_id,
        input.tool_use_id,
        input.tool_name,
        JSON.stringify(input.args),
        input.result_text,
        input.is_error ? 1 : 0,
        input.duration_ms
      );
  }

  /**
   * Fork a session at a specific user message: create a NEW session whose
   * history contains every message persisted BEFORE `beforeMessageId`
   * (exclusive). The target message itself is NOT copied — the caller
   * (dashboard) will seed the composer with its text so the user can edit
   * and re-send. Provider/model/group are inherited. Plans and tasks state
   * are intentionally NOT copied; the fork starts with a clean interactive
   * slate from that point.
   *
   * Returns the new session + the extracted text of the target message
   * (concatenation of its `type: 'text'` blocks) so the dashboard can
   * pre-fill the composer in a single round-trip.
   */
  forkSessionBeforeMessage(
    sourceSessionId: number,
    beforeMessageId: number,
  ): { session: CoderSession; seed_text: string } {
    const src = this.loadSessionWithMessages(sourceSessionId);
    if (!src) throw new Error(`source session ${sourceSessionId} not found`);

    const targetIdx = src.message_rows.findIndex((r) => r.id === beforeMessageId);
    if (targetIdx < 0) throw new Error(`message ${beforeMessageId} not in session`);
    const targetRow = src.message_rows[targetIdx];
    if (targetRow.role !== 'user') {
      throw new Error(`message ${beforeMessageId} is not a user message (role=${targetRow.role})`);
    }

    // Extract the text of the target user message to seed the composer.
    const targetContent = JSON.parse(targetRow.content_json) as Array<{
      type: string;
      text?: string;
    }>;
    const seedText = targetContent
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('\n');

    const tx = this.db.transaction(() => {
      const created = this.createSession({
        project_id: src.session.project_id,
        title: `${src.session.title} (fork)`,
        provider: src.session.provider,
        model: src.session.model,
      });
      // Inherit group so the fork lands next to its sibling.
      if (src.session.group_id != null) {
        this.setSessionGroup(created.id, src.session.group_id);
      }
      // Copy messages strictly before the target (exclusive).
      const copyStmt = this.db.prepare(`
        INSERT INTO coder_messages
          (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < targetIdx; i++) {
        const r = src.message_rows[i];
        copyStmt.run(
          created.id,
          r.role,
          r.content_json,
          r.input_tokens ?? 0,
          r.output_tokens ?? 0,
          r.cache_read_tokens ?? 0,
          r.cache_creation_tokens ?? 0,
        );
      }
      return this.getSession(created.id)!;
    });

    const session = tx();
    return { session, seed_text: seedText };
  }

  loadSessionWithMessages(id: number): SessionWithMessages | null {
    const session = this.getSession(id);
    if (!session) return null;
    const rows = this.db
      .prepare('SELECT * FROM coder_messages WHERE session_id = ? ORDER BY id')
      .all(id) as CoderMessageRow[];
    const messages: AgentMessage[] = rows.map((r) => ({
      role: r.role,
      content: JSON.parse(r.content_json),
    }));
    return { session, messages, message_rows: rows };
  }

  /** Total number of messages in a session (cheap COUNT query). */
  getMessageCount(sessionId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM coder_messages WHERE session_id = ?')
      .get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Load the tail of a session: last `tail` renderable messages (user +
   * assistant) plus all their interleaved tool-result messages.
   *
   * A naïve `LIMIT tail` on raw rows can return nothing but tool-role
   * messages (common in large sessions with many tool calls), which the
   * frontend cannot render. Instead we:
   *   1. Find the id of the Nth-from-last non-tool message.
   *   2. Load everything from that id onward (capped at 5×tail to prevent
   *      loading hundreds of tool results).
   */
  loadSessionMessagesTail(id: number, tail: number): SessionWithMessages | null {
    const session = this.getSession(id);
    if (!session) return null;

    // Find the cutoff: id of the Nth non-tool message from the end.
    const cutoff = this.db
      .prepare(`
        SELECT id FROM coder_messages
         WHERE session_id = ? AND role != 'tool'
         ORDER BY id DESC
         LIMIT 1 OFFSET ?
      `)
      .get(id, Math.max(0, tail - 1)) as { id: number } | undefined;

    let rows: CoderMessageRow[];
    if (cutoff) {
      rows = this.db
        .prepare(`
          SELECT * FROM coder_messages
           WHERE session_id = ? AND id >= ?
           ORDER BY id
           LIMIT ?
        `)
        .all(id, cutoff.id, tail * 5) as CoderMessageRow[];
    } else {
      // Fewer non-tool messages than requested — load last tail*5 from the end.
      rows = this.db
        .prepare(`
          SELECT * FROM coder_messages
           WHERE session_id = ?
           ORDER BY id DESC
           LIMIT ?
        `)
        .all(id, tail * 5) as CoderMessageRow[];
      rows.reverse();
    }

    const messages: AgentMessage[] = rows.map((r) => ({
      role: r.role,
      content: JSON.parse(r.content_json),
    }));
    return { session, messages, message_rows: rows };
  }

  /**
   * Load `limit` renderable messages (user + assistant) before a given
   * message id, plus their interleaved tool messages.
   * Returns in chronological order (ascending id).
   */
  loadMessagesBefore(
    sessionId: number,
    beforeId: number,
    limit: number,
  ): { messages: AgentMessage[]; message_rows: CoderMessageRow[] } {
    // Find the cutoff: id of the Nth non-tool message before beforeId.
    const cutoff = this.db
      .prepare(`
        SELECT id FROM coder_messages
         WHERE session_id = ? AND id < ? AND role != 'tool'
         ORDER BY id DESC
         LIMIT 1 OFFSET ?
      `)
      .get(sessionId, beforeId, Math.max(0, limit - 1)) as { id: number } | undefined;

    let rows: CoderMessageRow[];
    if (cutoff) {
      rows = this.db
        .prepare(`
          SELECT * FROM coder_messages
           WHERE session_id = ? AND id >= ? AND id < ?
           ORDER BY id
        `)
        .all(sessionId, cutoff.id, beforeId) as CoderMessageRow[];
    } else {
      // Fewer than requested — load all before beforeId
      rows = this.db
        .prepare(`
          SELECT * FROM coder_messages
           WHERE session_id = ? AND id < ?
           ORDER BY id
        `)
        .all(sessionId, beforeId) as CoderMessageRow[];
    }
    // Already in chronological order (ORDER BY id ASC).
    const messages: AgentMessage[] = rows.map((r) => ({
      role: r.role,
      content: JSON.parse(r.content_json),
    }));
    return { messages, message_rows: rows };
  }

  /** Load a single message by id (targeted query, no full-session load). */
  getMessageById(
    sessionId: number,
    messageId: number,
  ): { role: string; content: unknown; row: CoderMessageRow } | null {
    const row = this.db
      .prepare('SELECT * FROM coder_messages WHERE session_id = ? AND id = ?')
      .get(sessionId, messageId) as CoderMessageRow | undefined;
    if (!row) return null;
    return { role: row.role, content: JSON.parse(row.content_json), row };
  }

  // ─── Plans ────────────────────────────────────────────────────

  /**
   * Persist a submit_plan call. Uses INSERT … ON CONFLICT(tool_use_id)
   * DO UPDATE so a session resumed after restart that re-emits the same
   * tool_use_id refreshes the existing row instead of duplicating.
   */
  recordPlan(input: {
    session_id: number;
    tool_use_id: string;
    plan_text: string;
    message_id?: number | null;
  }): CoderPlanRow {
    this.db
      .prepare(`
        INSERT INTO coder_plans (session_id, tool_use_id, plan_text, message_id, status)
        VALUES (?, ?, ?, ?, 'pending')
        ON CONFLICT(tool_use_id) DO UPDATE SET
          plan_text = excluded.plan_text,
          message_id = COALESCE(excluded.message_id, coder_plans.message_id)
      `)
      .run(
        input.session_id,
        input.tool_use_id,
        input.plan_text,
        input.message_id ?? null,
      );
    return this.db
      .prepare('SELECT * FROM coder_plans WHERE tool_use_id = ?')
      .get(input.tool_use_id) as CoderPlanRow;
  }

  resolvePlan(toolUseId: string, status: CoderPlanStatus, feedback?: string): void {
    this.db
      .prepare(`
        UPDATE coder_plans
           SET status = ?,
               feedback = ?,
               resolved_at = datetime('now')
         WHERE tool_use_id = ?
      `)
      .run(status, feedback ?? null, toolUseId);
  }

  listPlans(sessionId: number): CoderPlanRow[] {
    return this.db
      .prepare('SELECT * FROM coder_plans WHERE session_id = ? ORDER BY created_at DESC, id DESC')
      .all(sessionId) as CoderPlanRow[];
  }

  getPlan(id: number): CoderPlanRow | null {
    const row = this.db
      .prepare('SELECT * FROM coder_plans WHERE id = ?')
      .get(id) as CoderPlanRow | undefined;
    return row ?? null;
  }

  /** Chronological trace of every `todo_write` call in a session. */
  listTodoHistory(sessionId: number): { id: number; args_json: string; created_at: string }[] {
    return this.db
      .prepare(`
        SELECT tc.id, tc.args_json, tc.created_at
          FROM coder_tool_calls tc
          JOIN coder_messages m ON m.id = tc.message_id
         WHERE m.session_id = ?
           AND tc.tool_name = 'todo_write'
         ORDER BY tc.created_at ASC, tc.id ASC
      `)
      .all(sessionId) as { id: number; args_json: string; created_at: string }[];
  }

  // ─── Tasks (migration 008) ────────────────────────────────────

  /**
   * Persist a fresh submit_tasks call. UPSERT keyed by session_id — there's
   * one task list per session at a time. Replacing means starting a new
   * decomposition discards the previous one (history lives in the message
   * log either way).
   */
  recordTasks(input: {
    session_id: number;
    tool_use_id: string;
    state: TasksState;
  }): CoderTasksRow {
    const json = JSON.stringify(input.state);
    this.db
      .prepare(`
        INSERT INTO coder_tasks_state (session_id, tool_use_id, state, version, created_at, updated_at)
        VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(session_id) DO UPDATE SET
          tool_use_id = excluded.tool_use_id,
          state = excluded.state,
          version = 1,
          updated_at = datetime('now')
      `)
      .run(input.session_id, input.tool_use_id, json);
    return this.db
      .prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?')
      .get(input.session_id) as CoderTasksRow;
  }

  /**
   * Apply the user's verdict on a pending task list. Merges any user-edited
   * tasks back into the persisted state, sets execution_mode + approved.
   * Bumps version monotonically.
   */
  resolveTasks(
    sessionId: number,
    verdict: { approved: boolean; tasks?: CoderTask[]; execution_mode?: TaskExecutionMode | null }
  ): TasksState | null {
    const current = this.getTasksState(sessionId);
    if (!current) return null;
    const next: TasksState = {
      ...current,
      tasks: verdict.tasks ?? current.tasks,
      execution_mode: verdict.execution_mode ?? current.execution_mode,
      approved: verdict.approved,
    };
    this.db
      .prepare(`
        UPDATE coder_tasks_state
           SET state = ?, version = version + 1, updated_at = datetime('now')
         WHERE session_id = ?
      `)
      .run(JSON.stringify(next), sessionId);
    return next;
  }

  /**
   * Surgical update of a single task's runtime fields (status, started_at,
   * finished_at, result, mode_used). Re-serializes the whole state — fine
   * because the JSON is small (kilobytes) and updates are infrequent.
   */
  updateTaskStatus(sessionId: number, taskId: string, patch: Partial<CoderTask>): TasksState | null {
    const current = this.getTasksState(sessionId);
    if (!current) return null;
    const idx = current.tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return null;
    const merged: CoderTask = { ...current.tasks[idx], ...patch };
    const next: TasksState = {
      ...current,
      tasks: current.tasks.map((t, i) => (i === idx ? merged : t)),
      current_task_id: patch.status === 'running' ? taskId : (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') && current.current_task_id === taskId ? null : current.current_task_id,
    };
    this.db
      .prepare(`
        UPDATE coder_tasks_state
           SET state = ?, version = version + 1, updated_at = datetime('now')
         WHERE session_id = ?
      `)
      .run(JSON.stringify(next), sessionId);
    return next;
  }

  getTasksState(sessionId: number): TasksState | null {
    const row = this.db
      .prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?')
      .get(sessionId) as CoderTasksRow | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.state) as TasksState;
    } catch {
      return null;
    }
  }

  /**
   * On session resume, any task stuck in 'running' is an orphan — the previous
   * runner died before the task could finish. Reset them to 'interrupted' so
   * `execute_task` can retry them.
   * Returns the number of tasks recovered (0 if nothing changed).
   */
  recoverStaleTasks(sessionId: number): number {
    const current = this.getTasksState(sessionId);
    if (!current) return 0;
    let recovered = 0;
    const tasks = current.tasks.map((t) => {
      if (t.status === 'running') {
        recovered++;
        return { ...t, status: 'interrupted' as const, finished_at: new Date().toISOString() };
      }
      return t;
    });
    if (recovered === 0) return 0;
    const next: TasksState = {
      ...current,
      tasks,
      current_task_id: null,
    };
    this.db
      .prepare(`
        UPDATE coder_tasks_state
           SET state = ?, version = version + 1, updated_at = datetime('now')
         WHERE session_id = ?
      `)
      .run(JSON.stringify(next), sessionId);
    console.log(`[coder] recoverStaleTasks: session ${sessionId} — recovered ${recovered} stuck task(s)`);
    return recovered;
  }

  // ─── Session groups (migration 009) ───────────────────────────

  listGroups(projectId: number): CoderSessionGroup[] {
    return this.db
      .prepare(
        'SELECT * FROM coder_session_groups WHERE project_id = ? ORDER BY sort_order, id'
      )
      .all(projectId) as CoderSessionGroup[];
  }

  createGroup(input: {
    project_id: number;
    name: string;
    color?: string | null;
  }): CoderSessionGroup {
    const r = this.db
      .prepare(
        'INSERT INTO coder_session_groups (project_id, name, color) VALUES (?, ?, ?)'
      )
      .run(input.project_id, input.name, input.color ?? null);
    return this.db
      .prepare('SELECT * FROM coder_session_groups WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as CoderSessionGroup;
  }

  updateGroup(
    id: number,
    patch: { name?: string; color?: string | null; sort_order?: number }
  ): CoderSessionGroup | null {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if (patch.sort_order !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sort_order);
    }
    if (sets.length === 0) {
      return (
        (this.db
          .prepare('SELECT * FROM coder_session_groups WHERE id = ?')
          .get(id) as CoderSessionGroup | undefined) ?? null
      );
    }
    sets.push("updated_at = datetime('now')");
    params.push(id);
    this.db
      .prepare(`UPDATE coder_session_groups SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return (
      (this.db
        .prepare('SELECT * FROM coder_session_groups WHERE id = ?')
        .get(id) as CoderSessionGroup | undefined) ?? null
    );
  }

  deleteGroup(id: number): void {
    // ON DELETE SET NULL on coder_sessions.group_id handles orphaned sessions.
    this.db.prepare('DELETE FROM coder_session_groups WHERE id = ?').run(id);
  }

  // ─── Disabled Tools (Per-Session) ──────────────────────────────

  /** Return the set of tool names disabled for this session. */
  getSessionDisabledTools(sessionId: number): Set<string> {
    const rows = this.db
      .prepare('SELECT tool_name FROM session_disabled_tools WHERE session_id = ?')
      .all(sessionId) as { tool_name: string }[];
    return new Set(rows.map((r) => r.tool_name));
  }

  /** Toggle a single tool for a session. */
  setSessionToolDisabled(sessionId: number, toolName: string, disabled: boolean): void {
    if (disabled) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO session_disabled_tools (session_id, tool_name)
           VALUES (?, ?)`,
        )
        .run(sessionId, toolName);
    } else {
      this.db
        .prepare('DELETE FROM session_disabled_tools WHERE session_id = ? AND tool_name = ?')
        .run(sessionId, toolName);
    }
  }

  /** Batch toggle tools for a session. */
  bulkSetSessionToolsDisabled(
    sessionId: number,
    toolNames: string[],
    disabled: boolean,
  ): void {
    const tx = this.db.transaction(() => {
      for (const name of toolNames) {
        this.setSessionToolDisabled(sessionId, name, disabled);
      }
    });
    tx();
  }

  /** Copy disabled tool config from one session to another. */
  copyToolConfig(fromSessionId: number, toSessionId: number): number {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM session_disabled_tools WHERE session_id = ?')
        .run(toSessionId);
      const r = this.db
        .prepare(
          `INSERT INTO session_disabled_tools (session_id, tool_name)
           SELECT ?, tool_name FROM session_disabled_tools WHERE session_id = ?`,
        )
        .run(toSessionId, fromSessionId);
      return r.changes ?? 0;
    });
    return tx() as number;
  }

  getTasksRow(sessionId: number): CoderTasksRow | null {
    const row = this.db
      .prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?')
      .get(sessionId) as CoderTasksRow | undefined;
    return row ?? null;
  }
}
