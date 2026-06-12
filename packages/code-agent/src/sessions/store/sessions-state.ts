import { createRequire } from 'node:module';
import type { Database as DB } from 'better-sqlite3';
import type { CoderSession } from '@mcp/code-agent/sessions/types.js';

const require = createRequire(import.meta.url);

/** Update the sticky agent preset. Called when the user switches modes mid-session. */
export function setAgent(db: DB, id: number, agent: string | null): void {
  db.prepare("UPDATE coder_sessions SET agent = ?, updated_at = datetime('now') WHERE id = ?").run(agent, id);
}

/**
 * Persist the per-session temperature override. Pass `null` to clear (the
 * resolver will fall back to the role/agent/default chain). The resolver
 * clamps at runtime, so out-of-range writes are tolerated here.
 */
export function setTemperature(db: DB, id: number, temperature: number | null): void {
  db.prepare("UPDATE coder_sessions SET temperature_override = ?, updated_at = datetime('now') WHERE id = ?").run(temperature, id);
}

/**
 * Persist the per-session "unrestricted tool output" toggle. Pass `null` to
 * clear (back to the production cap defaults). Stored as 0|1|NULL.
 */
export function setUnrestrictedToolOutput(db: DB, id: number, enabled: boolean | null): void {
  const v = enabled == null ? null : enabled ? 1 : 0;
  db.prepare("UPDATE coder_sessions SET unrestricted_tool_output = ?, updated_at = datetime('now') WHERE id = ?").run(v, id);
}

/**
 * Persist the per-session tool permission mode ('ask' | 'auto' |
 * 'unrestricted'). Pass `null` to clear (runtime falls back to 'auto').
 */
export function setToolPermissionMode(db: DB, id: number, mode: string | null): void {
  db.prepare("UPDATE coder_sessions SET tool_permission_mode = ?, updated_at = datetime('now') WHERE id = ?").run(mode, id);
}

/**
 * Append a tool name to the session's "always allow" grant list (JSON
 * string[]). Idempotent — re-granting an already-granted tool is a no-op.
 */
export function addToolPermissionGrant(db: DB, id: number, toolName: string): void {
  const row = db.prepare('SELECT tool_permission_grants FROM coder_sessions WHERE id = ?')
    .get(id) as { tool_permission_grants: string | null } | undefined;
  if (!row) return;
  let grants: string[] = [];
  try {
    const parsed = JSON.parse(row.tool_permission_grants ?? '[]');
    if (Array.isArray(parsed)) grants = parsed.filter((g): g is string => typeof g === 'string');
  } catch { /* corrupted column — rebuild from scratch */ }
  if (grants.includes(toolName)) return;
  grants.push(toolName);
  db.prepare("UPDATE coder_sessions SET tool_permission_grants = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(grants), id);
}

/**
 * Bump `updated_at` only. Used as a keep-alive while a tool approval is
 * pending so the stuck-running watchdog doesn't flip the session to idle.
 */
export function touchSession(db: DB, id: number): void {
  db.prepare("UPDATE coder_sessions SET updated_at = datetime('now') WHERE id = ?").run(id);
}

/**
 * Persist the Responses API state needed to enable `previous_response_id` on
 * the next turn for ChatGPT/Codex sessions. `messageCount` is the size of the
 * AgentMessage[] array we just sent — the backend now owns that prefix.
 */
export function setLastResponseState(db: DB, id: number, responseId: string | null, messageCount: number | null): void {
  db.prepare("UPDATE coder_sessions SET last_response_id = ?, last_response_message_count = ?, updated_at = datetime('now') WHERE id = ?").run(responseId, messageCount, id);
}

export function setArchived(db: DB, id: number, archived: boolean): void {
  db.prepare(`
    UPDATE coder_sessions
       SET is_archived = ?,
           archived_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
           updated_at = updated_at
     WHERE id = ?
  `).run(archived ? 1 : 0, archived ? 1 : 0, id);
}

export function setFavorite(db: DB, id: number, favorite: boolean): void {
  db.prepare(`
    UPDATE coder_sessions
       SET is_favorite = ?,
           favorited_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
     WHERE id = ?
  `).run(favorite ? 1 : 0, favorite ? 1 : 0, id);
}

export function setTitle(db: DB, id: number, title: string): void {
  db.prepare("UPDATE coder_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id);
}

export function setGroup(db: DB, id: number, groupId: number | null): void {
  db.prepare('UPDATE coder_sessions SET group_id = ? WHERE id = ?').run(groupId, id);
}

/** Replace the serialized lightweight todo list. Null to clear. */
export function setTodos(db: DB, id: number, todosJson: string | null): void {
  db.prepare("UPDATE coder_sessions SET todos_json = ?, updated_at = datetime('now') WHERE id = ?").run(todosJson, id);
}

/**
 * Set or clear the worktree path for a session. Called by `enter_worktree`
 * (set) and `exit_worktree` (clear). Persisted so a session resume after a
 * server restart can restore the runner's cwd.
 */
export function setWorktree(db: DB, id: number, worktreePath: string | null): void {
  db.prepare("UPDATE coder_sessions SET worktree_path = ?, updated_at = datetime('now') WHERE id = ?").run(worktreePath, id);
}

/**
 * High-water mark of memory distillation (migration 136): the last message id
 * already covered by a distillation pass. The compaction harvest advances it
 * (to the boundary); the idle sweeper distills only messages PAST it and
 * advances it even on error (anti poison-pill). NOTE: never moves backwards —
 * concurrent passes can only widen coverage.
 */
export function setMemoryDistilledBoundary(db: DB, id: number, messageId: number): void {
  db.prepare(
    'UPDATE coder_sessions SET memory_distilled_message_id = MAX(memory_distilled_message_id, ?) WHERE id = ?',
  ).run(messageId, id);
}

export function getMemoryDistilledBoundary(db: DB, id: number): number {
  const row = db.prepare('SELECT memory_distilled_message_id AS m FROM coder_sessions WHERE id = ?')
    .get(id) as { m: number | null } | undefined;
  return row?.m ?? 0;
}

/** Get existing cloudcode_session_id or generate + persist a new one. */
export function getOrCreateCloudCodeSessionId(db: DB, id: number): string {
  const row = db.prepare('SELECT cloudcode_session_id FROM coder_sessions WHERE id = ?').get(id) as { cloudcode_session_id: string | null } | undefined;
  if (row?.cloudcode_session_id) return row.cloudcode_session_id;
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  const sid = randomUUID();
  db.prepare("UPDATE coder_sessions SET cloudcode_session_id = ?, updated_at = datetime('now') WHERE id = ?").run(sid, id);
  return sid;
}

export function updateStatus(db: DB, id: number, status: CoderSession['status']): void {
  db.prepare("UPDATE coder_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function updateProvider(db: DB, id: number, provider: string, model: string): void {
  db.prepare("UPDATE coder_sessions SET provider = ?, model = ?, updated_at = datetime('now') WHERE id = ?").run(provider, model, id);
}

/** Get the per-session fallback provider/model override (if configured). */
export function getFallback(db: DB, id: number): { provider: string; model: string } | null {
  const row = db.prepare('SELECT fallback_provider, fallback_model FROM coder_sessions WHERE id = ?')
    .get(id) as { fallback_provider: string | null; fallback_model: string | null } | undefined;
  if (!row || !row.fallback_provider || !row.fallback_model) return null;
  return { provider: row.fallback_provider, model: row.fallback_model };
}

/** Set or clear the per-session fallback provider/model override. */
export function setFallback(db: DB, id: number, provider: string | null, model: string | null): void {
  db.prepare("UPDATE coder_sessions SET fallback_provider = ?, fallback_model = ?, updated_at = datetime('now') WHERE id = ?").run(provider, model, id);
}

export function bumpUsage(
  db: DB, id: number, inputTokens: number, outputTokens: number,
  cacheReadTokens = 0, cacheCreationTokens = 0,
): void {
  db.prepare(`
    UPDATE coder_sessions
       SET total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?,
           total_cache_read_tokens = total_cache_read_tokens + ?,
           total_cache_creation_tokens = total_cache_creation_tokens + ?,
           last_turn_input_tokens = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, inputTokens, id);
}

/** Camada 4 — base commit captured at session creation for the reviewer subagent. */
export function setBaseCommit(db: DB, sessionId: number, sha: string | null): void {
  db.prepare("UPDATE coder_sessions SET base_commit_sha = ?, updated_at = datetime('now') WHERE id = ?").run(sha, sessionId);
}

/** Camada 4 — stamp last_review_at when request_review finishes. */
export function markReviewedNow(db: DB, sessionId: number): void {
  db.prepare("UPDATE coder_sessions SET last_review_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(sessionId);
}
