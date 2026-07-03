/**
 * Append-only session event log (migration 195, Codex parity).
 *
 * One row per notable session-lifecycle event — a generic
 * (kind, from_state → to_state, reason, actor) shape mirroring
 * `company_service_transitions`. This is the queryable audit/replay trail Codex
 * keeps in its rollout; ours lives in the central SQLite so the existing
 * per-session tooling can join against it.
 *
 * All writes are best-effort: a logging failure must never break the operation
 * being logged (session create, resume, goal change, ...). Kinds are advisory
 * strings (no DB CHECK) so new event types don't need a migration.
 */
import type { Database as DB } from 'better-sqlite3';

/** Known event kinds. Extend freely — the column has no CHECK constraint. */
export type SessionEventKind =
  | 'session_created'
  | 'session_resumed'
  | 'config_captured'
  | 'config_drift'
  | 'goal_changed'
  | 'compaction';

export interface SessionEventInput {
  session_id: number;
  kind: SessionEventKind | string;
  from_state?: string | null;
  to_state?: string | null;
  reason?: string | null;
  /** Who caused it: 'system' | 'user' | 'agent' | 'resume' | ... */
  actor: string;
  /** Millisecond timestamp; defaults to now. */
  at_ms?: number;
}

export interface SessionEventRow {
  id: number;
  session_id: number;
  kind: string;
  from_state: string | null;
  to_state: string | null;
  reason: string | null;
  actor: string;
  at_ms: number;
}

/**
 * Append one event. Best-effort: swallows errors (e.g. table missing on an
 * un-migrated DB) so it can be dropped into hot paths without a guard.
 */
export function recordSessionEvent(db: DB, event: SessionEventInput): void {
  try {
    db.prepare(
      `INSERT INTO session_events (session_id, kind, from_state, to_state, reason, actor, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.session_id,
      event.kind,
      event.from_state ?? null,
      event.to_state ?? null,
      event.reason ?? null,
      event.actor,
      event.at_ms ?? Date.now(),
    );
  } catch {
    /* best-effort audit — never break the caller */
  }
}

/** Read a session's events, newest first. Optionally filter by kind. */
export function listSessionEvents(
  db: DB,
  sessionId: number,
  opts?: { kind?: string; limit?: number },
): SessionEventRow[] {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 2000);
  const where = opts?.kind ? 'WHERE session_id = ? AND kind = ?' : 'WHERE session_id = ?';
  const params = opts?.kind ? [sessionId, opts.kind, limit] : [sessionId, limit];
  return db
    .prepare(`SELECT * FROM session_events ${where} ORDER BY at_ms DESC, id DESC LIMIT ?`)
    .all(...params) as SessionEventRow[];
}
