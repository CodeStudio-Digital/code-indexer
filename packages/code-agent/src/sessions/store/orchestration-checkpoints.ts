import { createHash, randomUUID } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';

export type OrchestrationCheckpointKind =
  | 'subagent_resume'
  | 'workflow'
  | 'agent_run_resolution';

export type OrchestrationCheckpointPrivacy =
  | 'session_private_redacted'
  | 'metadata_only';

export interface SaveOrchestrationCheckpointInput {
  sessionId: number;
  kind: OrchestrationCheckpointKind;
  scopeId: string;
  privacyClass: OrchestrationCheckpointPrivacy;
  payloadJson: string;
  expiresAt: string;
  /** Required when another executor currently holds the checkpoint lease. */
  leaseToken?: string;
}

export interface OrchestrationCheckpointRow {
  sessionId: number;
  kind: OrchestrationCheckpointKind;
  scopeId: string;
  schemaVersion: 1;
  privacyClass: OrchestrationCheckpointPrivacy;
  payloadJson: string;
  byteSize: number;
  expiresAt: string;
  version: number;
}

function tableExists(db: DB): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='coder_orchestration_checkpoints'",
  ).get());
}

function maxBytes(kind: OrchestrationCheckpointKind): number {
  const fallback = kind === 'subagent_resume'
    ? 8 * 1024 * 1024
    : kind === 'workflow'
      ? 512 * 1024
      : 256 * 1024;
  const suffix = kind.toUpperCase();
  const configured = Number(process.env[`CODER_${suffix}_CHECKPOINT_MAX_BYTES`] ?? fallback);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : fallback;
}

function hash(payloadJson: string): string {
  return createHash('sha256').update(payloadJson).digest('hex');
}

interface PersistedCheckpointRow {
  session_id: number;
  checkpoint_kind: OrchestrationCheckpointKind;
  scope_id: string;
  schema_version: number;
  privacy_class: OrchestrationCheckpointPrivacy;
  payload_json: string;
  payload_hash: string;
  byte_size: number;
  expires_at: string;
  version: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

function hydrate(row: PersistedCheckpointRow): OrchestrationCheckpointRow {
  return {
    sessionId: row.session_id,
    kind: row.checkpoint_kind,
    scopeId: row.scope_id,
    schemaVersion: 1,
    privacyClass: row.privacy_class,
    payloadJson: row.payload_json,
    byteSize: row.byte_size,
    expiresAt: row.expires_at,
    version: row.version,
  };
}

function validIntegrity(row: PersistedCheckpointRow): boolean {
  return row.schema_version === 1
    && Buffer.byteLength(row.payload_json, 'utf8') === row.byte_size
    && hash(row.payload_json) === row.payload_hash
    && row.byte_size <= maxBytes(row.checkpoint_kind);
}

function deleteInvalid(db: DB, row: PersistedCheckpointRow, now: string): void {
  db.prepare(`
    DELETE FROM coder_orchestration_checkpoints
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
  `).run(row.session_id, row.checkpoint_kind, row.scope_id, now);
}

/**
 * Saves an already-redacted payload. Returns false when migration 259 is not
 * present (partial fixtures/rolling upgrade) or the explicit byte ceiling
 * rejects it; callers keep their in-memory fallback in both cases.
 */
export function save(
  db: DB,
  input: SaveOrchestrationCheckpointInput,
): boolean {
  if (!tableExists(db)) return false;
  const byteSize = Buffer.byteLength(input.payloadJson, 'utf8');
  if (byteSize > maxBytes(input.kind)) return false;
  const now = new Date().toISOString();
  const payloadHash = hash(input.payloadJson);
  if (input.leaseToken) {
    const result = db.prepare(`
      UPDATE coder_orchestration_checkpoints
      SET privacy_class=?,
        payload_json=?,
        payload_hash=?,
        byte_size=?,
        updated_at=?,
        expires_at=?,
        version=version + 1
      WHERE session_id=? AND checkpoint_kind=? AND scope_id=?
        AND lease_owner=? AND lease_expires_at > ?
    `).run(
      input.privacyClass,
      input.payloadJson,
      payloadHash,
      byteSize,
      now,
      input.expiresAt,
      input.sessionId,
      input.kind,
      input.scopeId,
      input.leaseToken,
      now,
    );
    return result.changes === 1;
  }
  const result = db.prepare(`
    INSERT INTO coder_orchestration_checkpoints (
      session_id, checkpoint_kind, scope_id, schema_version, privacy_class,
      payload_json, payload_hash, byte_size, created_at, updated_at, expires_at,
      version
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(session_id, checkpoint_kind, scope_id) DO UPDATE SET
      privacy_class=excluded.privacy_class,
      payload_json=excluded.payload_json,
      payload_hash=excluded.payload_hash,
      byte_size=excluded.byte_size,
      updated_at=excluded.updated_at,
      expires_at=excluded.expires_at,
      version=coder_orchestration_checkpoints.version + 1
    WHERE coder_orchestration_checkpoints.lease_owner IS NULL
  `).run(
    input.sessionId,
    input.kind,
    input.scopeId,
    input.privacyClass,
    input.payloadJson,
    payloadHash,
    byteSize,
    now,
    now,
    input.expiresAt,
  );
  return result.changes === 1;
}

export function load(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  scopeId: string,
  now = new Date().toISOString(),
): OrchestrationCheckpointRow | null {
  if (!tableExists(db)) return null;
  db.prepare(`
    DELETE FROM coder_orchestration_checkpoints
    WHERE expires_at <= ?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
  `).run(now, now);
  const row = db.prepare(`
    SELECT session_id, checkpoint_kind, scope_id, schema_version, privacy_class,
      payload_json, payload_hash, byte_size, expires_at, version,
      lease_owner, lease_expires_at
    FROM coder_orchestration_checkpoints
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=? AND expires_at > ?
  `).get(sessionId, kind, scopeId, now) as PersistedCheckpointRow | undefined;
  if (!row) return null;
  if (!validIntegrity(row)) {
    deleteInvalid(db, row, now);
    return null;
  }
  return hydrate(row);
}

export function list(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  limit = 50,
  now = new Date().toISOString(),
): OrchestrationCheckpointRow[] {
  if (!tableExists(db)) return [];
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT session_id, checkpoint_kind, scope_id, schema_version, privacy_class,
      payload_json, payload_hash, byte_size, expires_at, version,
      lease_owner, lease_expires_at
    FROM coder_orchestration_checkpoints
    WHERE session_id=? AND checkpoint_kind=? AND expires_at > ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(sessionId, kind, now, safeLimit) as PersistedCheckpointRow[];
  const valid: OrchestrationCheckpointRow[] = [];
  for (const row of rows) {
    if (!validIntegrity(row)) {
      deleteInvalid(db, row, now);
      continue;
    }
    valid.push(hydrate(row));
  }
  return valid;
}

export function remove(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  scopeId: string,
  leaseToken?: string,
): void {
  if (!tableExists(db)) return;
  db.prepare(`
    DELETE FROM coder_orchestration_checkpoints
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=?
      AND (lease_owner IS NULL OR lease_owner=?)
  `).run(sessionId, kind, scopeId, leaseToken ?? null);
}

/**
 * Cross-realm/process lease. Missing migration/row preserves the pre-259
 * in-memory behaviour. Existing rows are acquired with one SQLite CAS.
 */
export function tryAcquire(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  scopeId: string,
  leaseMs = 120_000,
): string | null {
  if (!tableExists(db)) return `compat:${randomUUID()}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + Math.max(60_000, leaseMs)).toISOString();
  const leaseToken = `lease:${randomUUID()}`;
  const result = db.prepare(`
    UPDATE coder_orchestration_checkpoints
    SET lease_owner=?, lease_expires_at=?, updated_at=?, version=version + 1
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
  `).run(
    leaseToken,
    expiresAt,
    now,
    sessionId,
    kind,
    scopeId,
    now,
  );
  return result.changes === 1 ? leaseToken : null;
}

/** Assert ownership and extend the same lease token in one CAS. */
export function renew(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  scopeId: string,
  leaseToken: string,
  leaseMs = 120_000,
): boolean {
  if (!tableExists(db)) return leaseToken.startsWith('compat:');
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + Math.max(60_000, leaseMs)).toISOString();
  return db.prepare(`
    UPDATE coder_orchestration_checkpoints
    SET lease_expires_at=?, updated_at=?, version=version + 1
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=?
      AND lease_owner=? AND lease_expires_at > ?
  `).run(expiresAt, now, sessionId, kind, scopeId, leaseToken, now).changes === 1;
}

export function release(
  db: DB,
  sessionId: number,
  kind: OrchestrationCheckpointKind,
  scopeId: string,
  leaseToken: string,
): void {
  if (!tableExists(db)) return;
  db.prepare(`
    UPDATE coder_orchestration_checkpoints
    SET lease_owner=NULL, lease_expires_at=NULL, updated_at=?, version=version + 1
    WHERE session_id=? AND checkpoint_kind=? AND scope_id=? AND lease_owner=?
  `).run(new Date().toISOString(), sessionId, kind, scopeId, leaseToken);
}
