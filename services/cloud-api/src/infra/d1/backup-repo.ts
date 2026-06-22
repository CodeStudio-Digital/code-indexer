/** BackupRepo over a DbExecutor (backups). Metadata only — the gz blob lives in
 *  R2. Owner-scoped reads/writes; deletes are a batch. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import type { BackupMeta, BackupRef, BackupRepo } from '../../backups/types.js';

interface BackupRow {
  id: string;
  r2_key: string;
  label: string;
  byte_size: number;
  content_sha256: string;
  manifest_json: string;
  created_at_ms: number;
  expires_at_ms: number | null;
}

const COLS = 'id, r2_key, label, byte_size, content_sha256, manifest_json, created_at_ms, expires_at_ms';

function toMeta(r: BackupRow): BackupMeta {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(r.manifest_json) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    r2Key: r.r2_key,
    label: r.label,
    byteSize: r.byte_size,
    contentSha256: r.content_sha256,
    manifest,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
  };
}

export function createBackupRepo(db: DbExecutor): BackupRepo {
  return {
    async insert(accountId, m) {
      await db.run(
        `INSERT INTO backups (account_id, ${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, m.id, m.r2Key, m.label, m.byteSize, m.contentSha256, JSON.stringify(m.manifest), m.createdAtMs, m.expiresAtMs],
      );
    },
    async listByOwner(accountId) {
      const rows = await db.all<BackupRow>(`SELECT ${COLS} FROM backups WHERE account_id = ? ORDER BY created_at_ms DESC`, [accountId]);
      return rows.map(toMeta);
    },
    async findById(accountId, id) {
      const row = await db.first<BackupRow>(`SELECT ${COLS} FROM backups WHERE account_id = ? AND id = ?`, [accountId, id]);
      return row ? toMeta(row) : null;
    },
    async listRefs(accountId) {
      const rows = await db.all<{ id: string; r2_key: string; created_at_ms: number; expires_at_ms: number | null }>(
        'SELECT id, r2_key, created_at_ms, expires_at_ms FROM backups WHERE account_id = ?',
        [accountId],
      );
      return rows.map((r): BackupRef => ({ id: r.id, r2Key: r.r2_key, createdAtMs: r.created_at_ms, expiresAtMs: r.expires_at_ms }));
    },
    async deleteByIds(accountId, ids) {
      if (!ids.length) return;
      await db.batch(ids.map((id) => ({ sql: 'DELETE FROM backups WHERE account_id = ? AND id = ?', params: [accountId, id] })));
    },
  };
}
