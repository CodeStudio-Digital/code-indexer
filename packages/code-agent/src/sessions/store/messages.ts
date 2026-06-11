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
  /**
   * Loop-guard refusal tag (mig 124). NULL on a real tool call; 'dedup' /
   * 'failure-streak' when the runner synthesized an `is_error=1` result to
   * BLOCK a cycling agent (no tool actually ran). Lets dashboards separate
   * real tool failures from guard interventions. Auto-derived from
   * `result_text` when omitted.
   */
  refusal_kind?: string | null;
}

/**
 * Tag a synthesized loop-guard refusal so it isn't miscounted as a tool
 * error. The tuple-hash dedup and failure-streak guards REPLACE the result
 * with a refusal whose text LEADS with a stable marker. Real tool failures
 * and guard REMINDERS (prepended to a real result) stay NULL.
 */
export function classifyToolRefusal(resultText: string, isError: boolean): string | null {
  if (!isError || !resultText) return null;
  if (resultText.startsWith('[loop-refused')) return 'dedup';
  if (resultText.startsWith('[failure-streak REFUSED')) return 'failure-streak';
  if (resultText.startsWith('[user-denied')) return 'user_denied';
  return null;
}

export function appendToolCall(db: DB, input: AppendToolCallInput): void {
  db.prepare(`
    INSERT INTO coder_tool_calls
      (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
       output_chars, output_chars_shaped, truncated, phase, turn_telemetry_id, refusal_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.message_id, input.tool_use_id, input.tool_name, JSON.stringify(input.args),
    input.result_text, input.is_error ? 1 : 0, input.duration_ms,
    input.output_chars ?? (input.result_text?.length ?? 0),
    input.output_chars_shaped ?? null,
    input.truncated ? 1 : 0, input.phase ?? null, input.turn_telemetry_id ?? null,
    input.refusal_kind ?? classifyToolRefusal(input.result_text, input.is_error),
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
       output_chars, output_chars_shaped, truncated, phase, turn_telemetry_id, refusal_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        tc.refusal_kind ?? classifyToolRefusal(tc.result_text, tc.is_error),
      );
    }
    // Persist the PAIRED tool-role message in the SAME transaction. The
    // dashboard derives a tool call's status purely from the presence of a
    // matching `tool_result` block, so a tool message that never lands shows a
    // perpetual "loading" spinner. The old host-side `flushToolMessages` index
    // scan silently dropped these whenever a mid-run compaction reassigned the
    // in-memory message array (it walked `runner.messages` from a stale cursor
    // that now pointed past the shrunken array) — that's why long auto-runs
    // that compact often (e.g. session 969) lost almost every tool result.
    // Rebuilding from the same `tool_calls` buffer that backs the audit rows
    // makes the assistant→tool pair atomic and immune to array mutation.
    if (input.tool_calls.length > 0) {
      const toolResultBlocks = input.tool_calls.map((tc) => ({
        type: 'tool_result' as const,
        tool_use_id: tc.tool_use_id,
        content: tc.result_text,
        is_error: tc.is_error,
        ...(tc.truncated
          ? { truncated: true, originalSize: tc.output_chars ?? tc.result_text.length }
          : {}),
      }));
      insertMsg.run(input.session_id, 'tool', JSON.stringify(toolResultBlocks), 0, 0, 0, 0);
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

/**
 * Manual "summarize & clear" boundary (migration 128). Messages with
 * `id <= boundary` are hidden from the default view (runner seed + dashboard).
 * Returns 0 when the session has no boundary set — so `id > 0` is a no-op
 * filter and every loader behaves exactly as before for normal sessions.
 */
export function getBoundary(db: DB, sessionId: number): number {
  const row = db
    .prepare('SELECT summary_boundary_id AS b FROM coder_sessions WHERE id = ?')
    .get(sessionId) as { b: number | null } | undefined;
  return row?.b ?? 0;
}

/**
 * Count of archived (pre-boundary) messages. Drives the dashboard's
 * "show earlier history" affordance — 0 means there is nothing hidden.
 */
export function getArchivedCount(db: DB, sessionId: number): number {
  const boundary = getBoundary(db, sessionId);
  if (boundary <= 0) return 0;
  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM coder_messages WHERE session_id = ? AND id <= ?')
    .get(sessionId, boundary) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function loadWithMessages(db: DB, id: number): SessionWithMessages | null {
  const session = sessionsCore.get(db, id);
  if (!session) return null;
  const boundary = session.summary_boundary_id ?? 0;
  const rows = db
    .prepare('SELECT * FROM coder_messages WHERE session_id = ? AND id > ? ORDER BY id')
    .all(id, boundary) as CoderMessageRow[];
  return { session, messages: rowsToAgentMessages(rows), message_rows: rows };
}

/** Number of *visible* messages in a session (respects the summary boundary). */
export function getCount(db: DB, sessionId: number): number {
  const boundary = getBoundary(db, sessionId);
  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM coder_messages WHERE session_id = ? AND id > ?')
    .get(sessionId, boundary) as { cnt: number } | undefined;
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
  const boundary = session.summary_boundary_id ?? 0;

  const cutoff = db
    .prepare(`
      SELECT id FROM coder_messages
       WHERE session_id = ? AND id > ? AND role != 'tool'
       ORDER BY id DESC
       LIMIT 1 OFFSET ?
    `)
    .get(id, boundary, Math.max(0, tail - 1)) as { id: number } | undefined;

  let rows: CoderMessageRow[];
  if (cutoff) {
    // cutoff.id is already > boundary, so the `id >= cutoff.id` window stays
    // inside the visible region.
    rows = db
      .prepare(`
        SELECT * FROM coder_messages
         WHERE session_id = ? AND id >= ?
         ORDER BY id
         LIMIT ?
      `)
      .all(id, cutoff.id, tail * 5) as CoderMessageRow[];
  } else {
    // Fewer non-tool messages than requested — load last tail*5 above boundary.
    rows = db.prepare(`
      SELECT * FROM coder_messages
       WHERE session_id = ? AND id > ?
       ORDER BY id DESC
       LIMIT ?
    `).all(id, boundary, tail * 5) as CoderMessageRow[];
    rows.reverse();
  }

  return { session, messages: rowsToAgentMessages(rows), message_rows: rows };
}

/**
 * Load `limit` renderable messages (user + assistant) before a given message
 * id, plus their interleaved tool messages. Returns in chronological order.
 *
 * By default the summary boundary is respected (pagination stops at the
 * boundary). Pass `includeArchived` to CROSS it — that's how the dashboard's
 * "show earlier history" button reveals the pre-summary transcript.
 */
export function loadBefore(
  db: DB, sessionId: number, beforeId: number, limit: number, includeArchived = false,
): { messages: AgentMessage[]; message_rows: CoderMessageRow[] } {
  const boundary = includeArchived ? 0 : getBoundary(db, sessionId);
  const cutoff = db
    .prepare(`
      SELECT id FROM coder_messages
       WHERE session_id = ? AND id < ? AND id > ? AND role != 'tool'
       ORDER BY id DESC
       LIMIT 1 OFFSET ?
    `)
    .get(sessionId, beforeId, boundary, Math.max(0, limit - 1)) as { id: number } | undefined;

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
       WHERE session_id = ? AND id < ? AND id > ?
       ORDER BY id
    `).all(sessionId, beforeId, boundary) as CoderMessageRow[];
  }
  return { messages: rowsToAgentMessages(rows), message_rows: rows };
}

/** Highest message id in a session (the boundary for a full "clear"). */
export function maxMessageId(db: DB, sessionId: number): number {
  return (db
    .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM coder_messages WHERE session_id = ?')
    .get(sessionId) as { m: number }).m;
}

/**
 * Set (or advance) the durable compaction boundary: hide every message with
 * `id <= boundaryId` and store `summaryText` as the prepended head summary
 * (the runner prepends it; the dashboard renders it as a card). Used by BOTH
 * the manual "summarize & clear" (`kind='manual'`, boundaryId = current MAX(id),
 * no tail) and the automatic durable compaction (`kind='auto'`, boundaryId = a
 * mid-transcript cutoff, so a recent tail stays visible).
 *
 * `kind` is required (not defaulted) so a new call site can't silently miscount:
 * it bumps the matching lifetime counter (`compaction_count_auto|manual`,
 * migration 130) IN THE SAME transaction as the boundary move, which the metrics
 * panel surfaces as "Sumarizações (auto/manual)".
 *
 * Also clears the ChatGPT/Codex `previous_response_id` pointer: the prefix it
 * referenced no longer matches the new baseline, so the next turn must
 * re-establish server-side state from the compacted history. Non-destructive —
 * old rows remain, reachable via `includeArchived` loads.
 */
export function setCompactionBoundary(
  db: DB, sessionId: number, summaryText: string, boundaryId: number,
  kind: 'auto' | 'manual',
): { boundary_id: number; pruned_count: number } {
  const tx = db.transaction(() => {
    const prevBoundary = getBoundary(db, sessionId);
    const prunedCount = (db
      .prepare('SELECT COUNT(*) AS c FROM coder_messages WHERE session_id = ? AND id > ? AND id <= ?')
      .get(sessionId, prevBoundary, boundaryId) as { c: number }).c;
    db.prepare(`
      UPDATE coder_sessions
         SET summary_boundary_id = ?,
             compaction_summary = ?,
             last_response_id = NULL,
             last_response_message_count = NULL,
             compaction_count_auto = compaction_count_auto + ?,
             compaction_count_manual = compaction_count_manual + ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      boundaryId, summaryText,
      kind === 'auto' ? 1 : 0,
      kind === 'manual' ? 1 : 0,
      sessionId,
    );
    return { boundary_id: boundaryId, pruned_count: prunedCount };
  });
  return tx();
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
