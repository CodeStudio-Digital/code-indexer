import { createRequire } from 'node:module';
import type { Database as DB } from 'better-sqlite3';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type {
  CoderMessageRow,
  SessionWithMessages,
} from '@mcp/code-agent/sessions/types.js';
import * as sessionsCore from './sessions-core.js';

const require = createRequire(import.meta.url);

export interface AppendMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function append(db: DB, sessionId: number, message: AgentMessage, usage?: AppendMessageUsage): number {
  // PR-4 (R8): persist `isMeta` so the dashboard can hide synthetic
  // runtime-injected reminders on resumed sessions. Migration 095:
  // `selected_skill_ids_json` carries the user's sidebar picks (stored only
  // when non-empty so legacy audit queries see NULL on every row that wasn't
  // sent with picks).
  const stmt = db.prepare(`
    INSERT INTO coder_messages
      (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, is_meta, selected_skill_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    message.selectedSkillIds && message.selectedSkillIds.length > 0
      ? JSON.stringify(message.selectedSkillIds)
      : null,
  );
  db.prepare("UPDATE coder_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  return Number(r.lastInsertRowid);
}

export interface AppendToolCallInput {
  message_id: number;
  tool_use_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  result_text: string;
  is_error: boolean;
  duration_ms: number;
  output_chars?: number;
  /**
   * Size of the content the LLM actually saw, AFTER smart-reducer shaping
   * and the push-time cap in `buildToolResultBlock`. Pair with `output_chars`
   * to compute per-call savings; NULL means "not recorded" (synthetic
   * refusals, pre-shaping early exits) and the savings aggregation COALESCEs
   * to `output_chars` (savings=0).
   */
  output_chars_shaped?: number | null;
  truncated?: boolean;
  phase?: string | null;
  turn_telemetry_id?: number | null;
}

export function appendToolCall(db: DB, input: AppendToolCallInput): void {
  db.prepare(`
    INSERT INTO coder_tool_calls
      (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
       output_chars, output_chars_shaped, truncated, phase, turn_telemetry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.message_id, input.tool_use_id, input.tool_name, JSON.stringify(input.args),
    input.result_text, input.is_error ? 1 : 0, input.duration_ms,
    input.output_chars ?? (input.result_text?.length ?? 0),
    input.output_chars_shaped ?? null,
    input.truncated ? 1 : 0, input.phase ?? null, input.turn_telemetry_id ?? null,
  );
}

export interface PersistAssistantTurnInput {
  session_id: number;
  message: AgentMessage;
  usage: AppendMessageUsage | null;
  tool_calls: Array<Omit<AppendToolCallInput, 'message_id'>>;
  subagent_usage?: AppendMessageUsage;
}

/**
 * Persist an entire assistant turn (message + tool calls + usage bump) in a
 * single SQLite transaction. Either the whole turn lands or none of it does
 * — prevents orphaned tool rows if the process dies mid-write.
 *
 * Accumulated subagent usage (summed from each tool call's subUsage) is
 * included in the bumpUsage call so dashboard cost totals stay consistent.
 */
export function persistAssistantTurn(db: DB, input: PersistAssistantTurnInput): number {
  const insertMsg = db.prepare(`
    INSERT INTO coder_messages
      (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const touchSession = db.prepare("UPDATE coder_sessions SET updated_at = datetime('now') WHERE id = ?");
  const insertTool = db.prepare(`
    INSERT INTO coder_tool_calls
      (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
       output_chars, output_chars_shaped, truncated, phase, turn_telemetry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bumpStmt = db.prepare(`
    UPDATE coder_sessions
       SET total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?,
           total_cache_read_tokens = total_cache_read_tokens + ?,
           total_cache_creation_tokens = total_cache_creation_tokens + ?,
           last_turn_input_tokens = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `);

  const tx = db.transaction(() => {
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
        messageId, tc.tool_use_id, tc.tool_name, JSON.stringify(tc.args),
        tc.result_text, tc.is_error ? 1 : 0, tc.duration_ms,
        tc.output_chars ?? (tc.result_text?.length ?? 0),
        tc.output_chars_shaped ?? null,
        tc.truncated ? 1 : 0, tc.phase ?? null, tc.turn_telemetry_id ?? null,
      );
    }
    if (input.usage) {
      bumpStmt.run(
        input.usage.input_tokens, input.usage.output_tokens,
        input.usage.cache_read_input_tokens ?? 0, input.usage.cache_creation_input_tokens ?? 0,
        input.usage.input_tokens, input.session_id,
      );
    }
    if (input.subagent_usage) {
      bumpStmt.run(
        input.subagent_usage.input_tokens, input.subagent_usage.output_tokens,
        input.subagent_usage.cache_read_input_tokens ?? 0, input.subagent_usage.cache_creation_input_tokens ?? 0,
        input.subagent_usage.input_tokens, input.session_id,
      );
    }
    return messageId;
  });
  return tx() as number;
}

function rowsToAgentMessages(rows: CoderMessageRow[]): AgentMessage[] {
  return rows.map((r) => ({
    role: r.role,
    content: JSON.parse(r.content_json),
    ...(r.is_meta ? { isMeta: true as const } : {}),
    ...(r.selected_skill_ids_json
      ? { selectedSkillIds: JSON.parse(r.selected_skill_ids_json) as string[] }
      : {}),
  }));
}

export function loadWithMessages(db: DB, id: number): SessionWithMessages | null {
  const session = sessionsCore.get(db, id);
  if (!session) return null;
  const rows = db.prepare('SELECT * FROM coder_messages WHERE session_id = ? ORDER BY id').all(id) as CoderMessageRow[];
  return { session, messages: rowsToAgentMessages(rows), message_rows: rows };
}

/** Total number of messages in a session (cheap COUNT query). */
export function getCount(db: DB, sessionId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM coder_messages WHERE session_id = ?').get(sessionId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Load the tail of a session: last `tail` renderable messages (user +
 * assistant) plus all their interleaved tool-result messages.
 *
 * A naïve `LIMIT tail` on raw rows can return nothing but tool-role messages
 * (common in large sessions with many tool calls), which the frontend cannot
 * render. Instead: find the id of the Nth-from-last non-tool message, then
 * load everything from that id onward (capped at 5×tail).
 */
export function loadTail(db: DB, id: number, tail: number): SessionWithMessages | null {
  const session = sessionsCore.get(db, id);
  if (!session) return null;

  const cutoff = db
    .prepare(`
      SELECT id FROM coder_messages
       WHERE session_id = ? AND role != 'tool'
       ORDER BY id DESC
       LIMIT 1 OFFSET ?
    `)
    .get(id, Math.max(0, tail - 1)) as { id: number } | undefined;

  let rows: CoderMessageRow[];
  if (cutoff) {
    rows = db
      .prepare(`
        SELECT * FROM coder_messages
         WHERE session_id = ? AND id >= ?
         ORDER BY id
         LIMIT ?
      `)
      .all(id, cutoff.id, tail * 5) as CoderMessageRow[];
  } else {
    // Fewer non-tool messages than requested — load last tail*5 from end.
    rows = db.prepare(`
      SELECT * FROM coder_messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?
    `).all(id, tail * 5) as CoderMessageRow[];
    rows.reverse();
  }

  return { session, messages: rowsToAgentMessages(rows), message_rows: rows };
}

/**
 * Load `limit` renderable messages (user + assistant) before a given message
 * id, plus their interleaved tool messages. Returns in chronological order.
 */
export function loadBefore(
  db: DB, sessionId: number, beforeId: number, limit: number,
): { messages: AgentMessage[]; message_rows: CoderMessageRow[] } {
  const cutoff = db
    .prepare(`
      SELECT id FROM coder_messages
       WHERE session_id = ? AND id < ? AND role != 'tool'
       ORDER BY id DESC
       LIMIT 1 OFFSET ?
    `)
    .get(sessionId, beforeId, Math.max(0, limit - 1)) as { id: number } | undefined;

  let rows: CoderMessageRow[];
  if (cutoff) {
    rows = db.prepare(`
      SELECT * FROM coder_messages
       WHERE session_id = ? AND id >= ? AND id < ?
       ORDER BY id
    `).all(sessionId, cutoff.id, beforeId) as CoderMessageRow[];
  } else {
    rows = db.prepare(`
      SELECT * FROM coder_messages
       WHERE session_id = ? AND id < ?
       ORDER BY id
    `).all(sessionId, beforeId) as CoderMessageRow[];
  }
  return { messages: rowsToAgentMessages(rows), message_rows: rows };
}

/** Load a single message by id (targeted query, no full-session load). */
export function getById(
  db: DB, sessionId: number, messageId: number,
): { role: string; content: unknown; row: CoderMessageRow } | null {
  const row = db.prepare('SELECT * FROM coder_messages WHERE session_id = ? AND id = ?')
    .get(sessionId, messageId) as CoderMessageRow | undefined;
  if (!row) return null;
  return { role: row.role, content: JSON.parse(row.content_json), row };
}
