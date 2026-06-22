/** SyncRepo over a DbExecutor (sync_documents + sync_document_versions), scoped
 *  to one account. Head writes + loser/superseded archives go in ONE atomic batch.
 *  `version` is the per-account monotonic feed sequence (assigned by the service). */
import type { Clock, DbExecutor, IdGen } from '@cloudstudio/cloud-kernel';
import { refKey, type SyncKind, type SyncLoser, type SyncRepo, type SyncRow, type SyncWrite } from '../../sync/types.js';

interface DocRow {
  kind: string;
  client_doc_id: string;
  version: number;
  body_json: string | null;
  body_sha256: string;
  deleted: number;
  updated_at_ms: number;
}

const DOC_COLS = 'kind, client_doc_id, version, body_json, body_sha256, deleted, updated_at_ms';

const UPSERT_DOC =
  `INSERT INTO sync_documents (account_id, ${DOC_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(account_id, kind, client_doc_id) DO UPDATE SET
     version = excluded.version, body_json = excluded.body_json, body_sha256 = excluded.body_sha256,
     deleted = excluded.deleted, updated_at_ms = excluded.updated_at_ms`;

const INSERT_ARCHIVE =
  `INSERT INTO sync_document_versions (id, account_id, kind, client_doc_id, version, body_json, body_sha256, reason, created_at_ms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function createSyncRepo(db: DbExecutor, accountId: string, ids: IdGen, clock: Clock): SyncRepo {
  const toRow = (r: DocRow): SyncRow => ({
    kind: r.kind as SyncKind,
    clientDocId: r.client_doc_id,
    version: r.version,
    bodyJson: r.body_json,
    bodySha256: r.body_sha256,
    deleted: r.deleted === 1,
    updatedAtMs: r.updated_at_ms,
  });

  return {
    async currentMaxVersion() {
      const row = await db.first<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM sync_documents WHERE account_id = ?', [accountId]);
      return row?.v ?? 0;
    },

    async loadAll() {
      const rows = await db.all<DocRow>(`SELECT ${DOC_COLS} FROM sync_documents WHERE account_id = ?`, [accountId]);
      const map = new Map<string, SyncRow>();
      for (const r of rows) map.set(refKey(r.kind as SyncKind, r.client_doc_id), toRow(r));
      return map;
    },

    async apply(writes: SyncWrite[], losers: SyncLoser[]) {
      const now = clock.now();
      const stmts: { sql: string; params: unknown[] }[] = [];
      for (const w of writes) {
        if (w.archivePrev) {
          stmts.push({
            sql: INSERT_ARCHIVE,
            params: [ids.uuid(), accountId, w.row.kind, w.row.clientDocId, w.archivePrev.version, w.archivePrev.bodyJson, w.archivePrev.bodySha256, w.archivePrev.reason, now],
          });
        }
        stmts.push({
          sql: UPSERT_DOC,
          params: [accountId, w.row.kind, w.row.clientDocId, w.row.version, w.row.bodyJson, w.row.bodySha256, w.row.deleted ? 1 : 0, w.row.updatedAtMs],
        });
      }
      for (const l of losers) {
        stmts.push({
          sql: INSERT_ARCHIVE,
          params: [ids.uuid(), accountId, l.kind, l.clientDocId, l.version, l.bodyJson, l.bodySha256, 'conflict_loser', now],
        });
      }
      if (stmts.length) await db.batch(stmts);
    },

    async listSince(kinds, sinceVersion, limit) {
      const ph = kinds.map(() => '?').join(', ');
      const rows = await db.all<DocRow>(
        `SELECT ${DOC_COLS} FROM sync_documents WHERE account_id = ? AND version > ? AND kind IN (${ph}) ORDER BY version ASC LIMIT ?`,
        [accountId, sinceVersion, ...kinds, limit],
      );
      return rows.map(toRow);
    },
  };
}
