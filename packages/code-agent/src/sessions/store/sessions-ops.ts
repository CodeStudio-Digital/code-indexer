import type { Database as DB } from 'better-sqlite3';
import type {
  CoderMessageRow,
  CoderSession,
  CoderSessionStats,
} from '@mcp/code-agent/sessions/types.js';
import { createRequire } from 'node:module';
import * as core from './sessions-core.js';
import * as state from './sessions-state.js';
import * as messages from './messages.js';
import * as plans from './plans.js';
import * as tasks from './tasks.js';
import * as goals from './goals.js';
import * as sessionDrive from './session-drive.js';
import * as chapters from './chapters.js';
import * as filesystemRoots from './filesystem-roots.js';

const require = createRequire(import.meta.url);

type RawMessageRow = CoderMessageRow & Record<string, unknown>;

function loadRawMessages(db: DB, sessionId: number): RawMessageRow[] {
  return db.prepare('SELECT * FROM coder_messages WHERE session_id = ? ORDER BY id')
    .all(sessionId) as RawMessageRow[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Copy persisted transcript rows and return the exact old->new id mapping used
 * by append-only chapters. Building the column list from the row keeps newer
 * message metadata byte-identical too (for example `is_meta`, selected skills
 * and `created_at`) instead of silently dropping it in session operations.
 */
function copyRawMessages(
  db: DB,
  targetSessionId: number,
  rows: readonly RawMessageRow[],
): Map<number, number> {
  const idMap = new Map<number, number>();
  if (rows.length === 0) return idMap;

  const columns = Object.keys(rows[0]).filter((column) => column !== 'id' && column !== 'session_id');
  const insert = db.prepare(`
    INSERT INTO coder_messages (session_id, ${columns.map(quoteIdentifier).join(', ')})
    VALUES (?, ${columns.map(() => '?').join(', ')})
  `);
  for (const row of rows) {
    const result = insert.run(targetSessionId, ...columns.map((column) => row[column]));
    idMap.set(row.id, Number(result.lastInsertRowid));
  }
  return idMap;
}

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

  // Cache-inclusive prompt of the LAST assistant turn — the at-rest
  // counterpart of the live `context_status.prompt_tokens`, so the header
  // context bar shows the same number before and during a run. The legacy
  // `last_turn_input_tokens` column is cache-blind (raw input only).
  const lastTurn = db
    .prepare(`
      SELECT input_tokens + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0) AS prompt_tokens
      FROM coder_messages
      WHERE session_id = ? AND role = 'assistant'
      ORDER BY id DESC LIMIT 1
    `)
    .get(id) as { prompt_tokens: number | null } | undefined;

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
    last_turn_prompt_tokens: lastTurn?.prompt_tokens ?? null,
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

export interface MemoryDistillPendingRow {
  session_id: number;
  project_id: number;
  provider: string;
  model: string;
  distilled_mark: number;
  /** Consecutive FAILED sweeps for this span (migration 185) — drives backoff
   *  in SQL and the retry cap in the sweeper. */
  attempts: number;
}

/**
 * Sessions whose transcript grew past the memory-distill high-water mark and
 * went idle — candidates for the idle memory sweeper. All-SQL time math
 * (sqlite `datetime('now')` is UTC without 'Z'; comparing in SQL avoids the
 * JS parse pitfall). Joined against `projects.memory_enabled` so disabled
 * projects never even surface. The idle threshold grows with the failure
 * streak (cheap linear backoff) — capped sessions still surface once so the
 * sweeper can close them out as `retry_cap`.
 */
export function listMemoryDistillPending(
  db: DB, idleSeconds: number, limit: number,
): MemoryDistillPendingRow[] {
  return db.prepare(`
    SELECT s.id AS session_id, s.project_id, s.provider, s.model,
           s.memory_distilled_message_id AS distilled_mark,
           s.memory_distill_attempts AS attempts
    FROM coder_sessions s
    JOIN projects p ON p.id = s.project_id
    WHERE s.status = 'idle'
      AND p.memory_enabled = 1
      AND s.updated_at < datetime('now', '-' ||
            CAST((? * (1 + s.memory_distill_attempts)) AS INTEGER) || ' seconds')
      AND EXISTS (
        SELECT 1 FROM coder_messages m
        WHERE m.session_id = s.id AND m.id > s.memory_distilled_message_id
      )
    ORDER BY s.updated_at ASC
    LIMIT ?
  `).all(idleSeconds, limit) as MemoryDistillPendingRow[];
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
  const sourceSession = core.get(db, sourceSessionId);
  if (!sourceSession) throw new Error(`source session ${sourceSessionId} not found`);
  // Forking must also work when the target user message is behind the current
  // summary boundary. The regular session loader intentionally hides that
  // region, so session operations read the immutable raw transcript directly.
  const sourceRows = loadRawMessages(db, sourceSessionId);

  const targetIdx = sourceRows.findIndex((r) => r.id === beforeMessageId);
  if (targetIdx < 0) throw new Error(`message ${beforeMessageId} not in session`);
  const targetRow = sourceRows[targetIdx];
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
      project_id: sourceSession.project_id,
      title: `${sourceSession.title} (fork)`,
      provider: sourceSession.provider,
      model: sourceSession.model,
    });
    if (sourceSession.group_id != null) state.setGroup(db, created.id, sourceSession.group_id);
    filesystemRoots.copy(db, sourceSessionId, created.id);
    const idMap = copyRawMessages(db, created.id, sourceRows.slice(0, targetIdx));
    // `chapters.copy` only copies chapters whose start AND end ids are mapped.
    // Therefore a fork inside a chapter keeps the last complete predecessor,
    // while the partially-covered remainder stays as ordinary visible history.
    const copiedChapters = chapters.copy(db, sourceSessionId, created.id, idMap);
    // Feature-flagged/pre-migration compatibility: a durable resume may exist
    // without chapter rows. Preserve it only when its full boundary is inside
    // the fork; a fork inside that archived span deliberately exposes raw text.
    const mappedLegacyBoundary = sourceSession.summary_boundary_id == null
      ? null
      : idMap.get(sourceSession.summary_boundary_id) ?? null;
    if (copiedChapters === 0 && mappedLegacyBoundary != null && sourceSession.compaction_summary) {
      db.prepare(`
        UPDATE coder_sessions
        SET summary_boundary_id = ?, compaction_summary = ?,
            last_response_id = NULL, last_response_message_count = NULL
        WHERE id = ?
      `).run(mappedLegacyBoundary, sourceSession.compaction_summary, created.id);
    }
    return core.get(db, created.id)!;
  });

  return { session: tx(), seed_text: seedText };
}

export interface RollbackResult {
  session: CoderSession;
  seed_text: string;
  /** Image/document attachments of the rolled-back message, ready to re-load
   *  into the composer (shape matches the dashboard `AgentAttachment`). Images
   *  and PDFs carry `base64`; text-backed documents (md/txt/json/csv/code)
   *  carry `text` instead — both must round-trip or the attachment is lost. */
  seed_attachments: Array<{ name: string; mediaType: string; path?: string; base64?: string; text?: string }>;
  had_attachments: boolean;
}

/**
 * Roll a session back to a user message, IN PLACE and DESTRUCTIVELY: delete the
 * target message AND everything after it, returning the target's text +
 * attachments so the caller can seed the composer for editing & re-sending.
 *
 * Unlike `forkBeforeMessage` (which copies a prefix into a NEW session and
 * leaves the source intact), this is the irreversible inverse. It also resets
 * the session-scoped "in-flight intent" that would otherwise be re-injected
 * into the next run's `<active-context>` describing now-deleted work:
 *  - `coder_plans` orphaned by the truncation (message_id is SET NULL, not
 *    cascaded) → cleared via `plans.clearFrom` BEFORE the message delete;
 *  - `coder_tasks_state` (active_task), the session goal, and `todos_json`
 *    (the todo_write checklist, rehydrated into `<active-context>`/`<session-state>`
 *    every turn) → cleared;
 *  - the Responses-API pointer (`last_response_id`) → nulled, same as
 *    `setCompactionBoundary`, since its server-side prefix is now stale;
 *  - `memory_distilled_message_id` → clamped to the new MAX(id) so the distiller
 *    doesn't skip a region;
 *  - token totals → recomputed from the surviving rows.
 *
 * Conversation chapters at/after the target are superseded and the summary
 * boundary/cache are restored from the latest surviving chapter.
 */
export function rollbackToMessage(
  db: DB, sessionId: number, messageId: number,
): RollbackResult {
  const target = messages.getById(db, sessionId, messageId);
  if (!target) throw new Error(`message ${messageId} not in session ${sessionId}`);
  if (target.role !== 'user') {
    throw new Error(`message ${messageId} is not a user message (role=${target.role})`);
  }

  const blocks = Array.isArray(target.content)
    ? (target.content as Array<{ type: string; text?: string; mediaType?: string; path?: string; base64?: string; name?: string }>)
    : [];
  const seedText = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('\n');
  // Images/PDFs carry base64; text-backed documents (md/txt/json/csv/code)
  // carry `text` and no base64. Keep BOTH and preserve whichever field is set,
  // otherwise text documents silently vanish from the re-seeded composer.
  const seedAttachments = blocks
    .filter((b) =>
      (b.type === 'image' && typeof b.base64 === 'string') ||
      (b.type === 'document' && (
        typeof b.path === 'string' || typeof b.base64 === 'string' || typeof b.text === 'string'
      )),
    )
    .map((b) => ({
      name: b.name ?? (b.type === 'image' ? 'image.png' : 'document'),
      mediaType: b.mediaType ?? (b.type === 'image' ? 'image/png' : 'application/octet-stream'),
      ...(typeof b.path === 'string' ? { path: b.path } : {}),
      ...(typeof b.base64 === 'string' ? { base64: b.base64 } : {}),
      ...(typeof b.text === 'string' ? { text: b.text } : {}),
    }));

  const tx = db.transaction(() => {
    // Clear plans BEFORE the message delete: it keys off message_id, which the
    // delete would SET NULL out from under us.
    plans.clearFrom(db, sessionId, messageId);
    tasks.clear(db, sessionId);
    goals.clear(db, sessionId);
    // Clear the live todo_write checklist — it's session-scoped (not message-
    // anchored) and would otherwise be re-injected describing deleted work.
    state.setTodos(db, sessionId, null);
    // Preserve the append-only audit trail: chapters touching the removed
    // region are superseded, never deleted, and the durable resume rolls back
    // to the latest chapter wholly before the target message.
    chapters.rollback(db, sessionId, messageId);
    db.prepare('DELETE FROM coder_messages WHERE session_id = ? AND id >= ?').run(sessionId, messageId);
    // Subqueries below run AFTER the delete, so they see the surviving rows.
    db.prepare(`
      UPDATE coder_sessions SET
        last_response_id = NULL,
        last_response_message_count = NULL,
        memory_distilled_message_id = MIN(
          memory_distilled_message_id,
          (SELECT COALESCE(MAX(id), 0) FROM coder_messages WHERE session_id = ?)
        ),
        total_input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM coder_messages WHERE session_id = ?),
        total_output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM coder_messages WHERE session_id = ?),
        total_cache_read_tokens = (SELECT COALESCE(SUM(cache_read_tokens), 0) FROM coder_messages WHERE session_id = ?),
        total_cache_creation_tokens = (SELECT COALESCE(SUM(cache_creation_tokens), 0) FROM coder_messages WHERE session_id = ?),
        last_turn_input_tokens = COALESCE(
          (SELECT input_tokens FROM coder_messages
            WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1), 0
        ),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId, sessionId, sessionId, sessionId, sessionId, sessionId, sessionId);
    return core.get(db, sessionId)!;
  });

  return {
    session: tx(),
    seed_text: seedText,
    seed_attachments: seedAttachments,
    had_attachments: seedAttachments.length > 0,
  };
}

/**
 * Duplicate a session: create a new session with the same provider/model/
 * group, the COMPLETE raw transcript (including archived rows), append-only
 * chapters and current resume copied, plus Session Drive notes. Useful for
 * branching experiments without losing the original conversation or context.
 */
export function duplicate(db: DB, sourceId: number): CoderSession {
  const sourceSession = core.get(db, sourceId);
  if (!sourceSession) throw new Error(`source session ${sourceId} not found`);
  const sourceRows = loadRawMessages(db, sourceId);

  const tx = db.transaction(() => {
    const created = core.create(db, {
      project_id: sourceSession.project_id,
      title: `${sourceSession.title} (cópia)`,
      provider: sourceSession.provider,
      model: sourceSession.model,
    });
    if (sourceSession.group_id != null) state.setGroup(db, created.id, sourceSession.group_id);
    filesystemRoots.copy(db, sourceId, created.id);
    // Inherit the Drive notes (project-scoped investigations are already shared).
    sessionDrive.copyMemory(db, sourceId, created.id);
    const idMap = copyRawMessages(db, created.id, sourceRows);
    chapters.copy(db, sourceId, created.id, idMap);

    // Chapters normally restore this cache themselves. Copy the source cache
    // explicitly as well so feature-flagged/pre-migration sessions that have a
    // durable resume but no chapter retain exactly the same restart point.
    const mappedBoundary = sourceSession.summary_boundary_id == null
      ? null
      : idMap.get(sourceSession.summary_boundary_id) ?? null;
    db.prepare(`
      UPDATE coder_sessions
      SET summary_boundary_id = ?, compaction_summary = ?,
          last_response_id = NULL, last_response_message_count = NULL
      WHERE id = ?
    `).run(
      mappedBoundary,
      mappedBoundary == null ? null : sourceSession.compaction_summary,
      created.id,
    );
    return core.get(db, created.id)!;
  });
  return tx();
}
