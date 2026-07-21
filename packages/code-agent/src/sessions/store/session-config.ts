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
import type { CoderExecutionMode } from '../types.js';

export interface SessionConfigLock {
  provider: string;
  model: string;
  permissionMode: string;
  executionMode: CoderExecutionMode;
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
  executionMode?: CoderExecutionMode;
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
  const reasoningEffort = input.reasoningEffort ?? null;
  const legacyUltra = typeof reasoningEffort === 'string'
    && reasoningEffort.trim().toLowerCase() === 'ultra';
  return {
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    executionMode: input.executionMode ?? (legacyUltra ? 'ultra' : 'standard'),
    reasoningEffort: legacyUltra ? null : reasoningEffort,
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
    'provider', 'model', 'permissionMode', 'executionMode', 'reasoningEffort',
    'planDepth', 'responseLanguage', 'outputStyle', 'temperature', 'toolOutputCapLevel',
  ];
  const drift: string[] = [];
  for (const f of fields) {
    if (stored[f] !== current[f]) drift.push(`${f}: ${String(stored[f])} → ${String(current[f])}`);
  }
  return drift;
}

/**
 * Upgrade a persisted pre-241 lock in memory. Legacy locks may omit the mode
 * and encode Ultra in `reasoningEffort`; normalizing avoids false drift after
 * migration 241 moves that intent to the dedicated session column.
 */
export function normalizeConfigLock(value: unknown): SessionConfigLock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lock = value as Record<string, unknown>;
  const reasoningEffort = typeof lock.reasoningEffort === 'string' || lock.reasoningEffort === null
    ? lock.reasoningEffort
    : null;
  const legacyUltra = typeof reasoningEffort === 'string'
    && reasoningEffort.trim().toLowerCase() === 'ultra';
  const explicitMode: CoderExecutionMode | null = lock.executionMode === 'ultra'
    ? 'ultra'
    : lock.executionMode === 'standard'
      ? 'standard'
      : null;
  const executionMode: CoderExecutionMode = explicitMode ?? (legacyUltra ? 'ultra' : 'standard');
  return {
    ...(lock as unknown as SessionConfigLock),
    executionMode,
    reasoningEffort: legacyUltra ? null : reasoningEffort,
  };
}

/** Read the stored lock for a session, or null when unset/unparseable. */
export function getConfigLock(db: DB, sessionId: number): SessionConfigLock | null {
  const row = db
    .prepare('SELECT session_config_lock_json AS j FROM coder_sessions WHERE id = ?')
    .get(sessionId) as { j: string | null } | undefined;
  if (!row?.j) return null;
  try {
    return normalizeConfigLock(JSON.parse(row.j));
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
