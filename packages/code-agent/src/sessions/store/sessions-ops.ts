import type { Database as DB } from 'better-sqlite3';
import type {
  CoderSession,
  CoderSessionStats,
} from '@mcp/code-agent/sessions/types.js';
import { createRequire } from 'node:module';
import * as core from './sessions-core.js';
import * as state from './sessions-state.js';
import * as messages from './messages.js';

const require = createRequire(import.meta.url);

/**
 * Aggregate metrics for a single session, computed in one round-trip via a
 * UNION of two queries: session totals + tool-call aggregates joined through
 * coder_messages.
 */
export function getStats(db: DB, id: number): CoderSessionStats | null {
  const session = db
    .prepare(`
      SELECT
        total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        last_turn_input_tokens, provider, model,
        CAST((julianday(updated_at) - julianday(created_at)) * 86400000 AS INTEGER) AS duration_ms
      FROM coder_sessions
      WHERE id = ?
    `)
    .get(id) as {
      total_input_tokens: number; total_output_tokens: number;
      total_cache_read_tokens: number; total_cache_creation_tokens: number;
      last_turn_input_tokens: number; provider: string; model: string;
      duration_ms: number;
    } | undefined;
  if (!session) return null;

  const msgStats = db
    .prepare(`
      SELECT
        COUNT(*) AS message_count,
        SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_turns
      FROM coder_messages
      WHERE session_id = ?
    `)
    .get(id) as { message_count: number; assistant_turns: number | null };

  const tools = db
    .prepare(`
      SELECT
        COUNT(*) AS tool_call_count,
        SUM(CASE WHEN tc.is_error = 1 THEN 1 ELSE 0 END) AS tool_error_count,
        COUNT(DISTINCT tc.tool_name) AS distinct_tools,
        SUM(CASE WHEN tc.tool_name IN ('spawn_agent', 'spawn_subagent', 'spawn_agents') THEN 1 ELSE 0 END) AS subagent_call_count,
        COALESCE(SUM(tc.duration_ms), 0) AS total_tool_duration_ms
      FROM coder_tool_calls tc
      JOIN coder_messages m ON m.id = tc.message_id
      WHERE m.session_id = ?
    `)
    .get(id) as {
      tool_call_count: number; tool_error_count: number | null;
      distinct_tools: number; subagent_call_count: number | null;
      total_tool_duration_ms: number;
    };

  // Resolve context_window for the dashboard fallback path. Mirrors the
  // runner's resolution chain (DB → registry prefix). Cheap — we look up via
  // the in-memory capabilities cache populated by mergeDBCapabilities() at boot.
  let contextWindow: number | null = null;
  try {
    // Lazy require keeps types.ts free of a hard dep on capabilities.
    // capabilities.getModelContextWindow walks: env → DB cache → registry → prefix.
    const capabilities = require('../../providers/capabilities.js') as {
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
    message_count: msgStats.message_count ?? 0,
    assistant_turns: msgStats.assistant_turns ?? 0,
    tool_call_count: tools.tool_call_count ?? 0,
    tool_error_count: tools.tool_error_count ?? 0,
    distinct_tools: tools.distinct_tools ?? 0,
    subagent_call_count: tools.subagent_call_count ?? 0,
    total_tool_duration_ms: tools.total_tool_duration_ms ?? 0,
    duration_ms: session.duration_ms ?? 0,
    context_window: contextWindow,
  };
}

/**
 * Fork a session at a specific user message: create a NEW session whose
 * history contains every message persisted BEFORE `beforeMessageId`
 * (exclusive). The target message itself is NOT copied — the caller seeds
 * the composer with its text so the user can edit and re-send.
 *
 * Provider/model/group are inherited. Plans and tasks state are NOT copied;
 * the fork starts with a clean interactive slate from that point.
 */
export function forkBeforeMessage(
  db: DB, sourceSessionId: number, beforeMessageId: number,
): { session: CoderSession; seed_text: string } {
  const src = messages.loadWithMessages(db, sourceSessionId);
  if (!src) throw new Error(`source session ${sourceSessionId} not found`);

  const targetIdx = src.message_rows.findIndex((r) => r.id === beforeMessageId);
  if (targetIdx < 0) throw new Error(`message ${beforeMessageId} not in session`);
  const targetRow = src.message_rows[targetIdx];
  if (targetRow.role !== 'user') {
    throw new Error(`message ${beforeMessageId} is not a user message (role=${targetRow.role})`);
  }

  // Extract the text of the target user message to seed the composer.
  const targetContent = JSON.parse(targetRow.content_json) as Array<{ type: string; text?: string }>;
  const seedText = targetContent
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n');

  const tx = db.transaction(() => {
    const created = core.create(db, {
      project_id: src.session.project_id,
      title: `${src.session.title} (fork)`,
      provider: src.session.provider,
      model: src.session.model,
    });
    if (src.session.group_id != null) state.setGroup(db, created.id, src.session.group_id);
    const copyStmt = db.prepare(`
      INSERT INTO coder_messages
        (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < targetIdx; i++) {
      const r = src.message_rows[i];
      copyStmt.run(
        created.id, r.role, r.content_json,
        r.input_tokens ?? 0, r.output_tokens ?? 0,
        r.cache_read_tokens ?? 0, r.cache_creation_tokens ?? 0,
      );
    }
    return core.get(db, created.id)!;
  });

  return { session: tx(), seed_text: seedText };
}

/**
 * Duplicate a session: create a new session with the same provider/model/
 * group and ALL messages copied. Useful for branching experiments without
 * losing the original conversation.
 */
export function duplicate(db: DB, sourceId: number): CoderSession {
  const src = messages.loadWithMessages(db, sourceId);
  if (!src) throw new Error(`source session ${sourceId} not found`);

  const tx = db.transaction(() => {
    const created = core.create(db, {
      project_id: src.session.project_id,
      title: `${src.session.title} (cópia)`,
      provider: src.session.provider,
      model: src.session.model,
    });
    if (src.session.group_id != null) state.setGroup(db, created.id, src.session.group_id);
    const copyStmt = db.prepare(`
      INSERT INTO coder_messages
        (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of src.message_rows) {
      copyStmt.run(
        created.id, r.role, r.content_json,
        r.input_tokens ?? 0, r.output_tokens ?? 0,
        r.cache_read_tokens ?? 0, r.cache_creation_tokens ?? 0,
      );
    }
    return core.get(db, created.id)!;
  });
  return tx();
}
