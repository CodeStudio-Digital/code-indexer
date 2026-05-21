import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { AgentMessage, ChatProviderResponseMeta } from '@mcp/code-agent/core/messages.js';
import type {
  CoderSession, CoderSessionGroup, CoderMessageRow, SessionWithMessages, CoderSessionStats, CoderPlanRow, CoderPlanStatus,
  CoderTask, TasksState, CoderTasksRow, TaskExecutionMode, RecentCoderSession,
  SessionInputKind, SessionInputRow,
} from '@mcp/code-agent/sessions/types.js';

type SessionRow = Omit<CoderSession, 'is_archived' | 'is_favorite' | 'unrestricted_tool_output'> & {
  is_archived: number;
  is_favorite: number;
  /** SQLite stores INTEGER 0|1|NULL — coerced to boolean|null at map time. */
  unrestricted_tool_output: number | null;
};

function mapSessionRow(row: SessionRow | undefined | null): CoderSession | null {
  if (!row) return null;
  const unrestricted = row.unrestricted_tool_output;
  return {
    ...row,
    is_archived: !!row.is_archived,
    is_favorite: !!row.is_favorite,
    unrestricted_tool_output: unrestricted == null ? null : !!unrestricted,
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

  /**
   * Escape hatch for sibling stores that operate on the same SQLite file.
   * Avoids opening a second WAL connection — the snapshot store and any
   * future side-store can construct against the same handle.
   */
  getDb(): DB {
    return this.db;
  }

  // ─── Sessions ─────────────────────────────────────────────────

  createSession(input: {
    project_id: number;
    title: string;
    provider: string;
    model: string;
    cloudcode_session_id?: string;
    agent?: string | null;
    /**
     * Optional phase profile binding (Camada 2). When set, the runner's
     * PhaseRouter resolves to this profile instead of walking the cascade
     * to project/global defaults. Null falls back to the cascade.
     */
    phase_profile_id?: number | null;
  }): CoderSession {
    const stmt = this.db.prepare(`
      INSERT INTO coder_sessions (project_id, title, provider, model, cloudcode_session_id, agent, phase_profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      input.project_id, input.title, input.provider, input.model,
      input.cloudcode_session_id ?? null,
      input.agent ?? null,
      input.phase_profile_id ?? null,
    );
    return this.getSession(Number(r.lastInsertRowid))!;
  }

  /** Update the sticky agent preset. Called when the user switches modes mid-session. */
  setSessionAgent(id: number, agent: string | null): void {
    this.db
      .prepare("UPDATE coder_sessions SET agent = ?, updated_at = datetime('now') WHERE id = ?")
      .run(agent, id);
  }

  /**
   * Persist the per-session temperature override. Pass `null` to clear (the
   * resolver will fall back to the role/agent/default chain). The resolver
   * clamps at runtime, so out-of-range writes are tolerated here.
   */
  setSessionTemperature(id: number, temperature: number | null): void {
    this.db
      .prepare(
        "UPDATE coder_sessions SET temperature_override = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(temperature, id);
  }

  /**
   * Persist the per-session "unrestricted tool output" toggle. Pass `null`
   * to clear (back to the production cap defaults). Stored as 0|1|NULL.
   */
  setSessionUnrestrictedToolOutput(id: number, enabled: boolean | null): void {
    const v = enabled == null ? null : enabled ? 1 : 0;
    this.db
      .prepare(
        "UPDATE coder_sessions SET unrestricted_tool_output = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(v, id);
  }

  /**
   * Persist the Responses API state needed to enable `previous_response_id`
   * on the next turn for ChatGPT/Codex sessions. `messageCount` is the size
   * of the AgentMessage[] array we just sent — the backend now owns that
   * prefix, so the next turn can ship only `messages.slice(messageCount)`.
   */
  setLastResponseState(id: number, responseId: string | null, messageCount: number | null): void {
    this.db
      .prepare(
        "UPDATE coder_sessions SET last_response_id = ?, last_response_message_count = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(responseId, messageCount, id);
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

  setSessionTitle(id: number, title: string): void {
    this.db
      .prepare("UPDATE coder_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(title, id);
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

  // ─── Session goal (migration 068) ─────────────────────────────

  /**
   * Read the current goal for a session, or null when none was ever set
   * AND when the migration columns are absent (older sqlite files).
   */
  getSessionGoal(id: number): {
    text: string;
    status: 'in_progress' | 'complete';
    budgetTokens: number | null;
    completionNote: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    let row: {
      goal_text: string | null;
      goal_status: string | null;
      goal_budget_tokens: number | null;
      goal_completion_note: string | null;
      goal_created_at: string | null;
      goal_updated_at: string | null;
    } | undefined;
    try {
      row = this.db
        .prepare(
          'SELECT goal_text, goal_status, goal_budget_tokens, goal_completion_note, goal_created_at, goal_updated_at ' +
          'FROM coder_sessions WHERE id = ?',
        )
        .get(id) as typeof row;
    } catch {
      return null; // table missing migration — degrade gracefully
    }
    if (!row || !row.goal_text || !row.goal_status) return null;
    return {
      text: row.goal_text,
      status: row.goal_status === 'complete' ? 'complete' : 'in_progress',
      budgetTokens: row.goal_budget_tokens,
      completionNote: row.goal_completion_note,
      createdAt: row.goal_created_at ?? '',
      updatedAt: row.goal_updated_at ?? row.goal_created_at ?? '',
    };
  }

  /**
   * Persist or replace the goal for a session. The runCoder wiring funnels
   * `create_goal` / `update_goal` here so the goal survives runner death and
   * shows up after a dashboard reload.
   */
  upsertSessionGoal(
    id: number,
    goal: {
      text: string;
      status: 'in_progress' | 'complete';
      budgetTokens?: number | null;
      completionNote?: string | null;
      createdAt: string;
      updatedAt: string;
    },
  ): void {
    try {
      this.db
        .prepare(
          'UPDATE coder_sessions SET ' +
          'goal_text = ?, goal_status = ?, goal_budget_tokens = ?, goal_completion_note = ?, ' +
          'goal_created_at = ?, goal_updated_at = ?, updated_at = datetime(\'now\') ' +
          'WHERE id = ?',
        )
        .run(
          goal.text,
          goal.status,
          goal.budgetTokens ?? null,
          goal.completionNote ?? null,
          goal.createdAt,
          goal.updatedAt,
          id,
        );
    } catch (e) {
      // Older db without migration 068 — log and let the in-memory
      // fallback in goal.ts keep things working for the live runner.
      console.warn(`[session-store] upsertSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Clear the goal for a session (used by tests, never by the tool itself). */
  clearSessionGoal(id: number): void {
    try {
      this.db
        .prepare(
          'UPDATE coder_sessions SET goal_text = NULL, goal_status = NULL, goal_budget_tokens = NULL, ' +
          'goal_completion_note = NULL, goal_created_at = NULL, goal_updated_at = NULL, ' +
          'updated_at = datetime(\'now\') WHERE id = ?',
        )
        .run(id);
    } catch {
      /* ignore */
    }
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
               last_turn_input_tokens = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `)
      .run(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, inputTokens, id);
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
    // PR-4 (R8): persist `isMeta` so the dashboard can hide synthetic
    // runtime-injected reminders on resumed sessions too. Migration 075
    // adds the column with default 0 — pre-PR-4 rows read back as
    // isMeta=undefined, which renders the same as the legacy "always
    // visible" behaviour.
    const stmt = this.db.prepare(`
      INSERT INTO coder_messages
        (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      sessionId,
      message.role,
      JSON.stringify(message.content),
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
      message.isMeta ? 1 : 0,
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
          last_turn_input_tokens,
          provider,
          model,
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
          last_turn_input_tokens: number;
          provider: string;
          model: string;
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

    // Resolve context_window for the dashboard fallback path. Mirrors the
    // runner's resolution chain (DB → registry prefix). Cheap — we don't
    // hit the DB for the model row twice; we look up via the in-memory
    // capabilities cache populated by mergeDBCapabilities() at boot.
    let contextWindow: number | null = null;
    try {
      // Lazy require keeps types.ts free of a hard dep on capabilities.
      // capabilities.getModelContextWindow itself walks: env → DB cache →
      // registry → prefix fallback.
      const capabilities = require('../providers/capabilities.js') as {
        getModelContextWindow?: (model: string) => number | null;
      };
      contextWindow = capabilities.getModelContextWindow?.(session.model) ?? null;
    } catch {
      /* best-effort */
    }

    return {
      total_input_tokens: session.total_input_tokens,
      total_output_tokens: session.total_output_tokens,
      total_cache_read_tokens: session.total_cache_read_tokens,
      total_cache_creation_tokens: session.total_cache_creation_tokens,
      last_turn_input_tokens: session.last_turn_input_tokens ?? 0,
      message_count: messages.message_count ?? 0,
      assistant_turns: messages.assistant_turns ?? 0,
      tool_call_count: tools.tool_call_count ?? 0,
      tool_error_count: tools.tool_error_count ?? 0,
      distinct_tools: tools.distinct_tools ?? 0,
      subagent_call_count: tools.subagent_call_count ?? 0,
      total_tool_duration_ms: tools.total_tool_duration_ms ?? 0,
      duration_ms: session.duration_ms ?? 0,
      context_window: contextWindow,
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
    output_chars?: number;
    truncated?: boolean;
    phase?: string | null;
    turn_telemetry_id?: number | null;
  }): void {
    this.db
      .prepare(`
        INSERT INTO coder_tool_calls
          (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
           output_chars, truncated, phase, turn_telemetry_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.message_id,
        input.tool_use_id,
        input.tool_name,
        JSON.stringify(input.args),
        input.result_text,
        input.is_error ? 1 : 0,
        input.duration_ms,
        input.output_chars ?? (input.result_text?.length ?? 0),
        input.truncated ? 1 : 0,
        input.phase ?? null,
        input.turn_telemetry_id ?? null,
      );
  }

  /**
   * Persist an entire assistant turn (message + tool calls + usage bump) in a
   * single SQLite transaction. Either the whole turn lands or none of it does
   * — prevents orphaned tool rows if the process dies mid-write.
   *
   * Accumulated subagent usage (summed from each tool call's subUsage) is
   * included in the bumpUsage call so dashboard cost totals stay consistent.
   */
  persistAssistantTurn(input: {
    session_id: number;
    message: AgentMessage;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    } | null;
    tool_calls: Array<{
      tool_use_id: string;
      tool_name: string;
      args: Record<string, unknown>;
      result_text: string;
      is_error: boolean;
      duration_ms: number;
      output_chars?: number;
      truncated?: boolean;
      phase?: string | null;
      turn_telemetry_id?: number | null;
    }>;
    subagent_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }): number {
    const insertMsg = this.db.prepare(`
      INSERT INTO coder_messages
        (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const touchSession = this.db.prepare(
      "UPDATE coder_sessions SET updated_at = datetime('now') WHERE id = ?",
    );
    const insertTool = this.db.prepare(`
      INSERT INTO coder_tool_calls
        (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
         output_chars, truncated, phase, turn_telemetry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const bumpStmt = this.db.prepare(`
      UPDATE coder_sessions
         SET total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             total_cache_read_tokens = total_cache_read_tokens + ?,
             total_cache_creation_tokens = total_cache_creation_tokens + ?,
             last_turn_input_tokens = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      const r = insertMsg.run(
        input.session_id,
        input.message.role,
        JSON.stringify(input.message.content),
        input.usage?.input_tokens ?? 0,
        input.usage?.output_tokens ?? 0,
        input.usage?.cache_read_input_tokens ?? 0,
        input.usage?.cache_creation_input_tokens ?? 0,
      );
      const messageId = Number(r.lastInsertRowid);
      touchSession.run(input.session_id);
      for (const tc of input.tool_calls) {
        insertTool.run(
          messageId,
          tc.tool_use_id,
          tc.tool_name,
          JSON.stringify(tc.args),
          tc.result_text,
          tc.is_error ? 1 : 0,
          tc.duration_ms,
          tc.output_chars ?? (tc.result_text?.length ?? 0),
          tc.truncated ? 1 : 0,
          tc.phase ?? null,
          tc.turn_telemetry_id ?? null,
        );
      }
      if (input.usage) {
        bumpStmt.run(
          input.usage.input_tokens,
          input.usage.output_tokens,
          input.usage.cache_read_input_tokens ?? 0,
          input.usage.cache_creation_input_tokens ?? 0,
          input.usage.input_tokens,
          input.session_id,
        );
      }
      if (input.subagent_usage) {
        bumpStmt.run(
          input.subagent_usage.input_tokens,
          input.subagent_usage.output_tokens,
          input.subagent_usage.cache_read_input_tokens ?? 0,
          input.subagent_usage.cache_creation_input_tokens ?? 0,
          input.subagent_usage.input_tokens,
          input.session_id,
        );
      }
      return messageId;
    });
    return tx() as number;
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

  /**
   * Duplicate a session: create a new session with the same provider/model/group
   * and ALL messages copied. Useful for branching experiments without losing
   * the original conversation.
   */
  duplicateSession(sourceId: number): CoderSession {
    const src = this.loadSessionWithMessages(sourceId);
    if (!src) throw new Error(`source session ${sourceId} not found`);

    const tx = this.db.transaction(() => {
      const created = this.createSession({
        project_id: src.session.project_id,
        title: `${src.session.title} (cópia)`,
        provider: src.session.provider,
        model: src.session.model,
      });
      if (src.session.group_id != null) {
        this.setSessionGroup(created.id, src.session.group_id);
      }
      const copyStmt = this.db.prepare(`
        INSERT INTO coder_messages
          (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of src.message_rows) {
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

    return tx();
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
      ...(r.is_meta ? { isMeta: true as const } : {}),
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
      ...(r.is_meta ? { isMeta: true as const } : {}),
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
      ...(r.is_meta ? { isMeta: true as const } : {}),
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

  // ─── Session inputs / hidden-prompt log (migration 061) ───────

  /**
   * Record a hidden prompt injected into the session (system prompt, skill
   * body fetched mid-conversation, system-reminder, or sub-agent prompt).
   *
   * Dedup: if the latest row for the same `(session_id, kind)` has the same
   * content hash, we skip — turn-over-turn the system prompt is usually
   * byte-identical (cache prefix), so we only persist when something
   * actually changed (skill loaded, tier expanded, etc.).
   */
  recordSessionInput(input: {
    session_id: number;
    kind: SessionInputKind;
    source_label: string;
    content: string;
    meta?: Record<string, unknown> | null;
  }): SessionInputRow | null {
    const hash = createHash('sha1').update(input.content).digest('hex');
    const last = this.db
      .prepare(
        `SELECT content_hash FROM coder_session_inputs
          WHERE session_id = ? AND kind = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(input.session_id, input.kind) as { content_hash: string } | undefined;
    if (last && last.content_hash === hash) return null;

    const meta = input.meta ? JSON.stringify(input.meta) : null;
    const r = this.db
      .prepare(
        `INSERT INTO coder_session_inputs
           (session_id, kind, source_label, content, content_hash, meta_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.session_id, input.kind, input.source_label, input.content, hash, meta);
    return this.db
      .prepare('SELECT * FROM coder_session_inputs WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as SessionInputRow;
  }

  /** Newest-first list for the Input tab in the session details modal. */
  listSessionInputs(sessionId: number): SessionInputRow[] {
    return this.db
      .prepare(
        `SELECT * FROM coder_session_inputs
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC`,
      )
      .all(sessionId) as SessionInputRow[];
  }

  // ─── Tasks (migration 008) ────────────────────────────────────

  /**
   * Persist a fresh submit_tasks call. UPSERT keyed by session_id — there's
   * one task list per session at a time.
   *
   * MERGE BEHAVIOR (added to fix the "agent recria tarefas e substitui as
   * atuais" complaint): when a previous task list exists, runtime state for
   * tasks whose `id` survives the re-submission is preserved — `status`,
   * `mode_used`, `started_at`, `finished_at`, and `result`. Plan-time fields
   * (`title`, `description`, `files`, `references`, `depends_on`,
   * `suggested_mode`, `estimated_complexity`) are taken from the new
   * submission so the agent can refine the plan. Tasks that disappear from
   * the new list are dropped (the agent decided to remove them); tasks with
   * a new id enter as plain `pending`.
   *
   * If the agent wants a true reset, it can use entirely new ids — none
   * match, nothing is preserved.
   */
  recordTasks(input: {
    session_id: number;
    tool_use_id: string;
    state: TasksState;
  }): CoderTasksRow {
    const previous = this.getTasksState(input.session_id);
    let mergedState: TasksState = input.state;
    if (previous && previous.tasks.length > 0) {
      const prevById = new Map(previous.tasks.map((t) => [t.id, t]));
      const mergedTasks: CoderTask[] = input.state.tasks.map((incoming) => {
        const prior = prevById.get(incoming.id);
        if (!prior) return incoming;
        // Preserve runtime/lifecycle fields from prior; take plan-time fields from incoming.
        return {
          ...incoming,
          status: prior.status,
          mode_used: prior.mode_used,
          started_at: prior.started_at,
          finished_at: prior.finished_at,
          result: prior.result,
        };
      });
      // Preserve current_task_id only if that id still exists in the new list.
      const survivedCurrent = previous.current_task_id && mergedTasks.some((t) => t.id === previous.current_task_id)
        ? previous.current_task_id
        : null;
      mergedState = {
        ...input.state,
        tasks: mergedTasks,
        current_task_id: survivedCurrent,
      };
    }
    const json = JSON.stringify(mergedState);
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

  // ─── Per-turn telemetry (migration 069) ───────────────────────
  //
  // One row per (run_id, turn). Captures token + tool usage so dashboards
  // can answer "where are tokens being spent?" with data instead of guesses.
  // Best-effort: failures are swallowed because telemetry must never break
  // a real turn.

  recordTurnTelemetry(input: {
    session_id: number | null;
    run_id: string;
    turn: number;
    is_subagent: boolean;
    provider: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    thinking_tokens: number | null;
    history_chars: number | null;
    tool_count: number;
    tools_called: string[];
    largest_tool_result_chars: number | null;
    compaction_triggered: boolean;
    summarizer_ran: boolean;
    paginate_count: number;
    /** System prompt size in chars on this turn. Migration 072. */
    system_prompt_chars?: number | null;
    /** Tools array (JSON-stringified) size in chars on this turn. Migration 072. */
    tools_def_chars?: number | null;
    /** USD cost computed from pricing table. Migration 072. */
    estimated_cost_usd?: number | null;
    /** Sanitized provider request/response metadata. Migration 093. */
    response_meta?: ChatProviderResponseMeta | null;
  }): number | null {
    try {
      const meta = input.response_meta ?? null;
      const request = meta?.request;
      const response = meta?.response;
      const requestBetasJson = request?.betas && request.betas.length > 0
        ? JSON.stringify(request.betas)
        : null;
      const responseRateLimitsJson =
        response?.rate_limits && Object.keys(response.rate_limits).length > 0
          ? JSON.stringify(response.rate_limits)
          : null;
      const r = this.db
        .prepare(
          `INSERT INTO coder_turn_telemetry (
            session_id, run_id, turn, is_subagent,
            provider, model,
            input_tokens, output_tokens,
            cache_read_input_tokens, cache_creation_input_tokens, thinking_tokens,
            history_chars, tool_count, tools_called_json,
            largest_tool_result_chars, compaction_triggered, summarizer_ran, paginate_count,
            system_prompt_chars, tools_def_chars, estimated_cost_usd,
            request_api_model, request_requested_model, request_display_model,
            request_max_tokens, request_stream, request_betas_json,
            request_thinking_type, request_effort,
            response_status, response_ok, response_request_id,
            response_retry_after, response_x_should_retry,
            response_rate_limits_json, response_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.session_id,
          input.run_id,
          input.turn,
          input.is_subagent ? 1 : 0,
          input.provider,
          input.model,
          input.input_tokens,
          input.output_tokens,
          input.cache_read_input_tokens,
          input.cache_creation_input_tokens,
          input.thinking_tokens,
          input.history_chars,
          input.tool_count,
          JSON.stringify(input.tools_called),
          input.largest_tool_result_chars,
          input.compaction_triggered ? 1 : 0,
          input.summarizer_ran ? 1 : 0,
          input.paginate_count,
          input.system_prompt_chars ?? null,
          input.tools_def_chars ?? null,
          input.estimated_cost_usd ?? null,
          request?.api_model ?? null,
          request?.requested_model ?? null,
          request?.display_model ?? null,
          request?.max_tokens ?? null,
          request?.stream == null ? null : request.stream ? 1 : 0,
          requestBetasJson,
          request?.thinking_type ?? null,
          request?.effort ?? null,
          response?.status ?? null,
          response?.ok == null ? null : response.ok ? 1 : 0,
          response?.request_id ?? null,
          response?.retry_after ?? null,
          response?.x_should_retry ?? null,
          responseRateLimitsJson,
          meta?.path ?? null,
        );
      return Number(r.lastInsertRowid);
    } catch (e) {
      // Telemetry must never break a turn — surface as warn and move on.
      console.warn(
        `[coder] recordTurnTelemetry failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Diagnostic breakdown of the first-turn payload — what the runner
   * actually shipped to the provider before any tool calls were made. This
   * is the answer to "why did turn 1 cost N tokens?".
   *
   *   system_prompt   — chars from the persisted 'system_prompt' input row
   *                     (the fully assembled system prompt, including
   *                     preamble + base + tier hint + skills + interaction
   *                     footer). NULL when the session never recorded one
   *                     (subagent / legacy session).
   *   tools_array     — chars + count from the persisted 'tools_snapshot'
   *                     input row (JSON-stringified tools array shipped to
   *                     the LLM). NULL when the session never recorded one.
   *   first_turn      — input/output tokens of turn=1 from the telemetry
   *                     table (best estimate of what the provider billed).
   *
   * The dashboard divides these to show a "system N% / tools M% / other R%"
   * pie of the first-turn input tokens, which makes payload bloat diagnose
   * itself instead of forcing the developer to re-derive it from logs.
   */
  getFirstTurnPayloadBreakdown(sessionId: number): {
    system_prompt_chars: number | null;
    tools_array_chars: number | null;
    tools_count: number | null;
    first_turn_input_tokens: number | null;
    first_turn_output_tokens: number | null;
    estimated_chars_per_token: number;
    skills_mode: string | null;
    skills_count: number | null;
  } {
    const sysRow = this.db
      .prepare(
        `SELECT content, meta_json FROM coder_session_inputs
         WHERE session_id = ? AND kind = 'system_prompt'
         ORDER BY id ASC LIMIT 1`,
      )
      .get(sessionId) as { content: string; meta_json: string | null } | undefined;
    const toolsRow = this.db
      .prepare(
        `SELECT content, meta_json FROM coder_session_inputs
         WHERE session_id = ? AND kind = 'tools_snapshot'
         ORDER BY id ASC LIMIT 1`,
      )
      .get(sessionId) as { content: string; meta_json: string | null } | undefined;
    const turn1 = this.db
      .prepare(
        `SELECT input_tokens, output_tokens, tools_def_chars, system_prompt_chars FROM coder_turn_telemetry
         WHERE session_id = ? AND is_subagent = 0
         ORDER BY turn ASC LIMIT 1`,
      )
      .get(sessionId) as
        | { input_tokens: number | null; output_tokens: number | null; tools_def_chars: number | null; system_prompt_chars: number | null }
        | undefined;

    let toolsCount: number | null = null;
    // Migration 072 introduced `manifest-v1`: content is a SHA-1 fingerprint
    // (40 chars) and the real byte count lives in `meta.content_chars`.
    // Legacy rows still have the full JSON in `content`. Detect and fall
    // back to the legacy semantics when the meta marker is missing.
    let toolsArrayChars: number | null = null;
    if (toolsRow?.meta_json) {
      try {
        const meta = JSON.parse(toolsRow.meta_json) as {
          tool_count?: number;
          content_chars?: number;
          schema?: string;
        };
        if (typeof meta.tool_count === 'number') toolsCount = meta.tool_count;
        if (meta.schema === 'manifest-v1' && typeof meta.content_chars === 'number') {
          toolsArrayChars = meta.content_chars;
        }
      } catch {
        /* malformed meta */
      }
    }
    // Preferred source: per-turn telemetry (Sprint 1) — captures the actual
    // tools array size on turn 1 even when no session-input row was written.
    if (toolsArrayChars == null && turn1?.tools_def_chars != null) {
      toolsArrayChars = turn1.tools_def_chars;
    }
    // Legacy fallback: pre-072 rows still have the full JSON in `content`,
    // so its length matches what was actually shipped.
    if (toolsArrayChars == null && toolsRow?.content) {
      // Heuristic: a 40-char hex string is almost certainly the new
      // fingerprint, not legacy content. Avoid reporting "tools = 40 chars".
      const isFingerprint = toolsRow.content.length === 40 && /^[0-9a-f]{40}$/.test(toolsRow.content);
      if (!isFingerprint) toolsArrayChars = toolsRow.content.length;
    }

    let skillsMode: string | null = null;
    let skillsCount: number | null = null;
    if (sysRow?.meta_json) {
      try {
        const meta = JSON.parse(sysRow.meta_json) as { skills_mode?: string; skill_ids?: string[] };
        if (typeof meta.skills_mode === 'string') skillsMode = meta.skills_mode;
        if (Array.isArray(meta.skill_ids)) skillsCount = meta.skill_ids.length;
      } catch {
        /* malformed meta */
      }
    }

    // System prompt size: prefer per-turn telemetry (Sprint 1, accurate
    // for what's actually on the wire), fall back to the legacy session-
    // input content length.
    const systemPromptChars =
      turn1?.system_prompt_chars ?? sysRow?.content.length ?? null;

    return {
      system_prompt_chars: systemPromptChars,
      tools_array_chars: toolsArrayChars,
      tools_count: toolsCount,
      first_turn_input_tokens: turn1?.input_tokens ?? null,
      first_turn_output_tokens: turn1?.output_tokens ?? null,
      // Conservative ratio (matches the chars-per-token heuristic in
      // compaction.ts so estimated tokens are consistent with the
      // compaction trigger thresholds).
      estimated_chars_per_token: 4,
      skills_mode: skillsMode,
      skills_count: skillsCount,
    };
  }

  /** Read all telemetry rows for a session, ordered by turn ascending. */
  getTurnTelemetry(sessionId: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT * FROM coder_turn_telemetry WHERE session_id = ? ORDER BY turn ASC, id ASC`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  /**
   * Aggregate per-session telemetry for the metrics modal in the chat view.
   * Returns totals across every turn (including subagent turns) plus a few
   * derived ratios. All values may be null when the session has no
   * telemetry rows yet (e.g. fresh session before turn 1).
   */
  getSessionTelemetrySummary(sessionId: number): {
    turn_count: number;
    subagent_turn_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_creation_tokens: number;
    total_thinking_tokens: number;
    cache_hit_ratio: number | null;
    total_tool_calls: number;
    compaction_turns: number;
    summarizer_turns: number;
    paginate_total: number;
    largest_tool_result_chars: number | null;
    last_history_chars: number | null;
    last_turn_at: string | null;
    tools_breakdown: Array<{
      name: string;
      calls: number;
      total_output_chars: number;
      avg_duration_ms: number;
      truncated_count: number;
    }>;
    /** Migration 072 — total USD cost for this session (estimated). */
    estimated_cost_usd: number;
    /** Migration 072 — average system prompt size on assistant turns. */
    system_prompt_avg_chars: number | null;
    /** Migration 072 — average tools array size on assistant turns. */
    tools_def_avg_chars: number | null;
    /** Migration 072 — fraction of tool calls that hit a truncation cap. */
    truncation_rate: number | null;
    /** Migration 072 — token+cost breakdown per phase (Camada 2). */
    phase_breakdown: Array<{
      phase: string;
      tool_calls: number;
      total_output_chars: number;
      total_duration_ms: number;
    }>;
  } {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*)                                   AS turn_count,
           COALESCE(SUM(is_subagent), 0)              AS subagent_turn_count,
           COALESCE(SUM(input_tokens), 0)             AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0)            AS total_output_tokens,
           COALESCE(SUM(cache_read_input_tokens), 0)  AS total_cache_read_tokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cache_creation_tokens,
           COALESCE(SUM(thinking_tokens), 0)          AS total_thinking_tokens,
           COALESCE(SUM(tool_count), 0)               AS total_tool_calls,
           COALESCE(SUM(compaction_triggered), 0)     AS compaction_turns,
           COALESCE(SUM(summarizer_ran), 0)           AS summarizer_turns,
           COALESCE(SUM(paginate_count), 0)           AS paginate_total,
           MAX(largest_tool_result_chars)             AS largest_tool_result_chars,
           MAX(history_chars)                         AS last_history_chars,
           MAX(created_at)                            AS last_turn_at,
           COALESCE(SUM(estimated_cost_usd), 0)       AS estimated_cost_usd,
           AVG(system_prompt_chars)                   AS system_prompt_avg_chars,
           AVG(tools_def_chars)                       AS tools_def_avg_chars
         FROM coder_turn_telemetry
         WHERE session_id = ?`,
      )
      .get(sessionId) as {
        turn_count: number;
        subagent_turn_count: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_read_tokens: number;
        total_cache_creation_tokens: number;
        total_thinking_tokens: number;
        total_tool_calls: number;
        compaction_turns: number;
        summarizer_turns: number;
        paginate_total: number;
        largest_tool_result_chars: number | null;
        last_history_chars: number | null;
        last_turn_at: string | null;
        estimated_cost_usd: number;
        system_prompt_avg_chars: number | null;
        tools_def_avg_chars: number | null;
      };

    // Migration 072: tools breakdown now JOINs coder_tool_calls for richer
    // metrics (output_chars, duration, truncation count) — the previous
    // tools_called_json path only knew counts. Falls back to that path
    // when no tool_calls rows exist for the session (e.g. sessions older
    // than migration 072 deployment).
    const toolStats = this.db
      .prepare(
        `SELECT
            tc.tool_name                              AS name,
            COUNT(*)                                  AS calls,
            COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
            COALESCE(AVG(tc.duration_ms), 0)          AS avg_duration_ms,
            COALESCE(SUM(tc.truncated), 0)            AS truncated_count
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         WHERE m.session_id = ?
         GROUP BY tc.tool_name
         ORDER BY total_output_chars DESC, calls DESC`,
      )
      .all(sessionId) as Array<{
        name: string;
        calls: number;
        total_output_chars: number;
        avg_duration_ms: number;
        truncated_count: number;
      }>;

    let tools_breakdown: Array<{
      name: string;
      calls: number;
      total_output_chars: number;
      avg_duration_ms: number;
      truncated_count: number;
    }>;
    if (toolStats.length > 0) {
      tools_breakdown = toolStats.map((r) => ({
        ...r,
        avg_duration_ms: Math.round(r.avg_duration_ms),
      }));
    } else {
      // Legacy fallback — only call counts.
      const rows = this.db
        .prepare(
          `SELECT tools_called_json FROM coder_turn_telemetry WHERE session_id = ?`,
        )
        .all(sessionId) as Array<{ tools_called_json: string | null }>;
      const breakdown = new Map<string, number>();
      for (const r of rows) {
        if (!r.tools_called_json) continue;
        try {
          const names = JSON.parse(r.tools_called_json) as unknown;
          if (Array.isArray(names)) {
            for (const n of names) {
              if (typeof n === 'string') breakdown.set(n, (breakdown.get(n) ?? 0) + 1);
            }
          }
        } catch {
          /* malformed row — ignore */
        }
      }
      tools_breakdown = [...breakdown.entries()]
        .map(([name, calls]) => ({
          name,
          calls,
          total_output_chars: 0,
          avg_duration_ms: 0,
          truncated_count: 0,
        }))
        .sort((a, b) => b.calls - a.calls);
    }

    // Migration 072: phase breakdown. NULL phase rows bucket as 'unknown'
    // until PhaseRouter (Camada 2) populates it. Useful day-1 because it
    // makes the empty-state visible (the dashboard renders the panel and
    // says "phase routing not active yet").
    const phaseRows = this.db
      .prepare(
        `SELECT
            COALESCE(tc.phase, 'unknown')             AS phase,
            COUNT(*)                                  AS tool_calls,
            COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
            COALESCE(SUM(tc.duration_ms), 0)          AS total_duration_ms
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         WHERE m.session_id = ?
         GROUP BY phase
         ORDER BY tool_calls DESC`,
      )
      .all(sessionId) as Array<{
        phase: string;
        tool_calls: number;
        total_output_chars: number;
        total_duration_ms: number;
      }>;

    // Truncation rate across all tool calls (NULL when no rows).
    const truncRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(truncated), 0) AS trunc
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         WHERE m.session_id = ?`,
      )
      .get(sessionId) as { total: number; trunc: number };
    const truncation_rate = truncRow.total > 0 ? truncRow.trunc / truncRow.total : null;

    const inputTotal = totals.total_input_tokens;
    const cacheRead = totals.total_cache_read_tokens;
    const cache_hit_ratio = inputTotal > 0 ? cacheRead / inputTotal : null;

    return {
      ...totals,
      cache_hit_ratio,
      tools_breakdown,
      phase_breakdown: phaseRows,
      truncation_rate,
    };
  }

  /**
   * Global telemetry aggregates for the admin dashboard. One row per session,
   * plus an overall totals object. Limit caps the number of session summaries
   * returned (default 50, ordered by total tokens desc).
   */
  getGlobalTelemetrySummary(opts: { limit?: number; project_id?: number | null; since?: string | null } = {}): {
    overall: {
      session_count: number;
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read_tokens: number;
      cache_hit_ratio: number | null;
      compaction_turns: number;
      paginate_total: number;
      /** Migration 072. */
      total_estimated_cost_usd: number;
      /** Migration 072. */
      truncation_rate: number | null;
    };
    by_provider: Array<{
      provider: string;
      turns: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    }>;
    by_model: Array<{
      model: string;
      turns: number;
      input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
    }>;
    skills_modes: Array<{ mode: string; sessions: number }>;
    /** Migration 072 — top tools globally by output_chars. */
    top_tools: Array<{
      name: string;
      calls: number;
      total_output_chars: number;
      avg_duration_ms: number;
      truncated_count: number;
    }>;
    /** Migration 072 — phase breakdown (Camada 2). */
    phase_breakdown: Array<{
      phase: string;
      tool_calls: number;
      total_output_chars: number;
      total_duration_ms: number;
    }>;
    top_sessions: Array<{
      session_id: number | null;
      title: string | null;
      provider: string | null;
      model: string | null;
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      cache_hit_ratio: number | null;
      last_turn_at: string | null;
      /** Migration 072. */
      estimated_cost_usd: number;
    }>;
  } {
    const limit = opts.limit ?? 50;
    // Build common WHERE clause for project + since filters. We index on
    // session.project_id and on telemetry.created_at, so a parameterized
    // string is fine — values are SQL-bound, not concatenated.
    const turnFilters: string[] = [];
    const turnParams: Array<string | number> = [];
    if (opts.project_id != null) {
      turnFilters.push(`t.session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
      turnParams.push(opts.project_id);
    }
    if (opts.since) {
      turnFilters.push(`t.created_at >= ?`);
      turnParams.push(opts.since);
    }
    const turnWhere = turnFilters.length > 0 ? ' AND ' + turnFilters.join(' AND ') : '';
    const turnWhereStandalone = turnFilters.length > 0 ? 'WHERE ' + turnFilters.join(' AND ') : '';

    const toolFilters: string[] = [];
    const toolParams: Array<string | number> = [];
    if (opts.project_id != null) {
      toolFilters.push(`m.session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
      toolParams.push(opts.project_id);
    }
    if (opts.since) {
      toolFilters.push(`tc.created_at >= ?`);
      toolParams.push(opts.since);
    }
    const toolWhere = toolFilters.length > 0 ? 'WHERE ' + toolFilters.join(' AND ') : '';
    const overall = this.db
      .prepare(
        `SELECT
           COUNT(DISTINCT t.session_id)               AS session_count,
           COUNT(*)                                   AS turn_count,
           COALESCE(SUM(t.input_tokens), 0)           AS total_input_tokens,
           COALESCE(SUM(t.output_tokens), 0)          AS total_output_tokens,
           COALESCE(SUM(t.cache_read_input_tokens), 0) AS total_cache_read_tokens,
           COALESCE(SUM(t.compaction_triggered), 0)   AS compaction_turns,
           COALESCE(SUM(t.paginate_count), 0)         AS paginate_total,
           COALESCE(SUM(t.estimated_cost_usd), 0)     AS total_estimated_cost_usd
         FROM coder_turn_telemetry t
         WHERE 1=1${turnWhere}`,
      )
      .get(...turnParams) as {
        session_count: number;
        turn_count: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_read_tokens: number;
        compaction_turns: number;
        paginate_total: number;
        total_estimated_cost_usd: number;
      };
    const cache_hit_ratio = overall.total_input_tokens > 0
      ? overall.total_cache_read_tokens / overall.total_input_tokens
      : null;

    const truncOverall = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(tc.truncated), 0) AS trunc
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         ${toolWhere}`,
      )
      .get(...toolParams) as { total: number; trunc: number };
    const truncation_rate = truncOverall.total > 0
      ? truncOverall.trunc / truncOverall.total
      : null;

    const by_provider = this.db
      .prepare(
        `SELECT t.provider AS provider, COUNT(*) AS turns,
                COALESCE(SUM(t.input_tokens), 0)         AS input_tokens,
                COALESCE(SUM(t.output_tokens), 0)        AS output_tokens,
                COALESCE(SUM(t.estimated_cost_usd), 0)   AS estimated_cost_usd
         FROM coder_turn_telemetry t
         WHERE t.provider IS NOT NULL${turnWhere}
         GROUP BY t.provider
         ORDER BY input_tokens DESC`,
      )
      .all(...turnParams) as Array<{
        provider: string;
        turns: number;
        input_tokens: number;
        output_tokens: number;
        estimated_cost_usd: number;
      }>;

    const by_model = this.db
      .prepare(
        `SELECT COALESCE(t.request_api_model, t.model) AS model, COUNT(*) AS turns,
                COALESCE(SUM(t.input_tokens), 0)         AS input_tokens,
                COALESCE(SUM(t.output_tokens), 0)        AS output_tokens,
                COALESCE(SUM(t.estimated_cost_usd), 0)   AS estimated_cost_usd
         FROM coder_turn_telemetry t
         WHERE COALESCE(t.request_api_model, t.model) IS NOT NULL${turnWhere}
         GROUP BY COALESCE(t.request_api_model, t.model)
         ORDER BY input_tokens DESC`,
      )
      .all(...turnParams) as Array<{
        model: string;
        turns: number;
        input_tokens: number;
        output_tokens: number;
        estimated_cost_usd: number;
      }>;

    // Skills mode adoption: count distinct sessions by the persisted
    // skills_mode meta. NULL meta (legacy rows) bucketed as 'unknown'.
    // Project filter rebinds via session_id; since filter rebinds via created_at.
    const skillsFilters: string[] = [`kind = 'system_prompt'`];
    const skillsParams: Array<string | number> = [];
    if (opts.project_id != null) {
      skillsFilters.push(`session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
      skillsParams.push(opts.project_id);
    }
    if (opts.since) {
      skillsFilters.push(`created_at >= ?`);
      skillsParams.push(opts.since);
    }
    const skillsModes = this.db
      .prepare(
        `SELECT
            COALESCE(json_extract(meta_json, '$.skills_mode'), 'unknown') AS mode,
            COUNT(DISTINCT session_id)                                     AS sessions
         FROM coder_session_inputs
         WHERE ${skillsFilters.join(' AND ')}
         GROUP BY mode
         ORDER BY sessions DESC`,
      )
      .all(...skillsParams) as Array<{ mode: string; sessions: number }>;

    const top_tools = this.db
      .prepare(
        `SELECT
            tc.tool_name                              AS name,
            COUNT(*)                                  AS calls,
            COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
            COALESCE(AVG(tc.duration_ms), 0)          AS avg_duration_ms,
            COALESCE(SUM(tc.truncated), 0)            AS truncated_count
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         ${toolWhere}
         GROUP BY tc.tool_name
         ORDER BY total_output_chars DESC, calls DESC
         LIMIT 25`,
      )
      .all(...toolParams) as Array<{
        name: string;
        calls: number;
        total_output_chars: number;
        avg_duration_ms: number;
        truncated_count: number;
      }>;

    const phase_breakdown = this.db
      .prepare(
        `SELECT
            COALESCE(tc.phase, 'unknown')             AS phase,
            COUNT(*)                                  AS tool_calls,
            COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
            COALESCE(SUM(tc.duration_ms), 0)          AS total_duration_ms
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
         ${toolWhere}
         GROUP BY phase
         ORDER BY tool_calls DESC`,
      )
      .all(...toolParams) as Array<{
        phase: string;
        tool_calls: number;
        total_output_chars: number;
        total_duration_ms: number;
      }>;

    const top_sessions = this.db
      .prepare(
        `SELECT t.session_id,
                s.title,
                s.provider,
                s.model,
                COUNT(*) AS turn_count,
                COALESCE(SUM(t.input_tokens), 0)            AS total_input_tokens,
                COALESCE(SUM(t.output_tokens), 0)           AS total_output_tokens,
                COALESCE(SUM(t.cache_read_input_tokens), 0) AS total_cache_read,
                COALESCE(SUM(t.estimated_cost_usd), 0)      AS estimated_cost_usd,
                MAX(t.created_at)                           AS last_turn_at
         FROM coder_turn_telemetry t
         LEFT JOIN coder_sessions s ON s.id = t.session_id
         WHERE t.session_id IS NOT NULL${turnWhere}
         GROUP BY t.session_id, s.title, s.provider, s.model
         ORDER BY total_input_tokens DESC
         LIMIT ?`,
      )
      .all(...turnParams, limit) as Array<{
        session_id: number | null;
        title: string | null;
        provider: string | null;
        model: string | null;
        turn_count: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_read: number;
        estimated_cost_usd: number;
        last_turn_at: string | null;
      }>;
    void turnWhereStandalone; // reserved for future filtered queries

    return {
      overall: { ...overall, cache_hit_ratio, truncation_rate },
      by_provider,
      by_model,
      skills_modes: skillsModes,
      top_tools: top_tools.map((r) => ({ ...r, avg_duration_ms: Math.round(r.avg_duration_ms) })),
      phase_breakdown,
      top_sessions: top_sessions.map((r) => ({
        session_id: r.session_id,
        title: r.title,
        provider: r.provider,
        model: r.model,
        turn_count: r.turn_count,
        total_input_tokens: r.total_input_tokens,
        total_output_tokens: r.total_output_tokens,
        cache_hit_ratio: r.total_input_tokens > 0
          ? r.total_cache_read / r.total_input_tokens
          : null,
        estimated_cost_usd: r.estimated_cost_usd,
        last_turn_at: r.last_turn_at,
      })),
    };
  }

  // ─── Phase profiles (migration 073) — REMOVED ──────────────────
  //
  // The PhaseRouter feature was removed because mid-turn provider/model
  // swaps were too disruptive in practice. The DB tables remain in place
  // (`coder_phase_profiles`, `coder_sessions.phase_profile_id`) so any
  // future re-enable doesn't need a new migration. CRUD methods are gone.

  // ─── Session helpers used by other features ────────────────────

  /** Camada 4 — base commit captured at session creation for the reviewer subagent. */
  setSessionBaseCommit(sessionId: number, sha: string | null): void {
    this.db
      .prepare("UPDATE coder_sessions SET base_commit_sha = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sha, sessionId);
  }

  /** Camada 4 — stamp last_review_at when request_review finishes. */
  markSessionReviewedNow(sessionId: number): void {
    this.db
      .prepare("UPDATE coder_sessions SET last_review_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(sessionId);
  }
}
