/**
 * Resolved config lock for coder sessions (migration 194, Codex parity).
 *
 * Captures the session's effective config (provider/model + the per-session
 * override knobs + approval mode) once, at session creation. On resume we
 * recompute the same snapshot and diff it against the stored lock: if a knob
 * drifted (model swapped, reasoning effort changed, permission mode flipped),
 * we surface it instead of silently running under different settings. Mirrors
 * `.referece/codex/codex-rs/core/src/config_lock.rs` (materialize + validate),
 * adapted to our SQLite session row. Drift is advisory (logged), not blocking —
 * this is a dev-first product.
 */
import type { Database as DB } from 'better-sqlite3';

export interface SessionConfigLock {
  provider: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string | null;
  planDepth: string | null;
  responseLanguage: string | null;
  outputStyle: string | null;
  temperature: number | null;
  toolOutputCapLevel: string | null;
  /** Millisecond timestamp of capture. Excluded from drift comparison. */
  capturedAtMs: number;
}

export interface ConfigLockInput {
  provider: string;
  model: string;
  permissionMode: string;
  reasoningEffort?: string | null;
  planDepth?: string | null;
  responseLanguage?: string | null;
  outputStyle?: string | null;
  temperature?: number | null;
  toolOutputCapLevel?: string | null;
  /** Injected so the function stays pure/testable (no `Date.now()` inside). */
  nowMs: number;
}

/** Build a lock snapshot from the effective config. Pure. */
export function buildConfigLock(input: ConfigLockInput): SessionConfigLock {
  return {
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    reasoningEffort: input.reasoningEffort ?? null,
    planDepth: input.planDepth ?? null,
    responseLanguage: input.responseLanguage ?? null,
    outputStyle: input.outputStyle ?? null,
    temperature: input.temperature ?? null,
    toolOutputCapLevel: input.toolOutputCapLevel ?? null,
    capturedAtMs: input.nowMs,
  };
}

/**
 * Compare a stored lock against the current one. Returns a list of
 * `field: old → new` drift descriptions (empty when nothing drifted).
 * `capturedAtMs` is ignored.
 */
export function diffConfigLock(stored: SessionConfigLock, current: SessionConfigLock): string[] {
  const fields: (keyof SessionConfigLock)[] = [
    'provider', 'model', 'permissionMode', 'reasoningEffort',
    'planDepth', 'responseLanguage', 'outputStyle', 'temperature', 'toolOutputCapLevel',
  ];
  const drift: string[] = [];
  for (const f of fields) {
    if (stored[f] !== current[f]) drift.push(`${f}: ${String(stored[f])} → ${String(current[f])}`);
  }
  return drift;
}

/** Read the stored lock for a session, or null when unset/unparseable. */
export function getConfigLock(db: DB, sessionId: number): SessionConfigLock | null {
  const row = db
    .prepare('SELECT session_config_lock_json AS j FROM coder_sessions WHERE id = ?')
    .get(sessionId) as { j: string | null } | undefined;
  if (!row?.j) return null;
  try {
    return JSON.parse(row.j) as SessionConfigLock;
  } catch {
    return null;
  }
}

/** Persist the lock snapshot on the session row. */
export function setConfigLock(db: DB, sessionId: number, lock: SessionConfigLock): void {
  db.prepare('UPDATE coder_sessions SET session_config_lock_json = ? WHERE id = ?').run(
    JSON.stringify(lock),
    sessionId,
  );
}
