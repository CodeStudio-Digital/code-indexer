/** DocSiteRepo over a DbExecutor (doc_sites). Insert is an atomic conditional
 *  under the per-account quota; `maxApiDocs < 0` means unlimited (plain insert).
 *  Timestamps are epoch ms. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import {
  asDocSiteId,
  asSlug,
  type DocSite,
  type DocSiteId,
  type DocSiteRepo,
  type DocStatus,
  type TryItMode,
  type Visibility,
} from '@cloudstudio/cloud-sharing';

interface DocRow {
  id: string;
  slug: string;
  owner_account_id: string;
  title: string;
  description: string;
  visibility: string;
  status: string;
  try_it_mode: string;
  spec_sha256: string;
  spec_signature: string;
  operation_count: number;
  created_at_ms: number;
  updated_at_ms: number;
  revoked_at_ms: number | null;
}

// Metadata columns (everything except the large spec_json blob).
const COLS =
  'id, slug, owner_account_id, title, description, visibility, status, try_it_mode, spec_sha256, spec_signature, operation_count, created_at_ms, updated_at_ms, revoked_at_ms';

const INSERT_COLS = `${COLS}, spec_json`;
const INSERT_VALUES = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

export function createDocRepo(db: DbExecutor): DocSiteRepo {
  const params = (doc: DocSite, specJson: string) => [
    doc.id, doc.slug, doc.ownerAccountId, doc.title, doc.description, doc.visibility, doc.status, doc.tryItMode,
    doc.specSha256, doc.specSignature, doc.operationCount, doc.createdAtMs, doc.updatedAtMs, doc.revokedAtMs, specJson,
  ];
  return {
    async insertIfUnderQuota(doc: DocSite, specJson: string, maxApiDocs: number) {
      if (maxApiDocs < 0) {
        const res = await db.run(`INSERT INTO doc_sites (${INSERT_COLS}) VALUES (${INSERT_VALUES})`, params(doc, specJson));
        return res.rowsAffected > 0;
      }
      // Conditional insert: COUNT subquery + INSERT run as ONE serialized D1
      // statement, so the quota can't be raced. rowsAffected === 0 ⇒ quota full.
      const res = await db.run(
        `INSERT INTO doc_sites (${INSERT_COLS})
         SELECT ${INSERT_VALUES}
         WHERE (SELECT COUNT(*) FROM doc_sites WHERE owner_account_id = ? AND status = 'active') < ?`,
        [...params(doc, specJson), doc.ownerAccountId, maxApiDocs],
      );
      return res.rowsAffected > 0;
    },

    async findBySlug(slug) {
      const row = await db.first<DocRow>(`SELECT ${COLS} FROM doc_sites WHERE slug = ?`, [slug]);
      return row ? toDoc(row) : null;
    },

    async loadSpecJson(id: DocSiteId) {
      const row = await db.first<{ spec_json: string }>('SELECT spec_json FROM doc_sites WHERE id = ?', [id]);
      return row?.spec_json ?? null;
    },

    async listByOwner(owner: AccountId) {
      const rows = await db.all<DocRow>(
        `SELECT ${COLS} FROM doc_sites WHERE owner_account_id = ? ORDER BY created_at_ms DESC`,
        [owner],
      );
      return rows.map(toDoc);
    },

    async revoke(id: DocSiteId, owner: AccountId, atMs: number) {
      const res = await db.run(
        "UPDATE doc_sites SET status = 'revoked', revoked_at_ms = ? WHERE id = ? AND owner_account_id = ? AND status = 'active'",
        [atMs, id, owner],
      );
      return res.rowsAffected > 0;
    },
  };
}

function toDoc(r: DocRow): DocSite {
  return {
    id: asDocSiteId(r.id),
    slug: asSlug(r.slug),
    ownerAccountId: asAccountId(r.owner_account_id),
    title: r.title,
    description: r.description,
    visibility: r.visibility as Visibility,
    status: r.status as DocStatus,
    tryItMode: r.try_it_mode as TryItMode,
    specSha256: r.spec_sha256,
    specSignature: r.spec_signature,
    operationCount: r.operation_count,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    revokedAtMs: r.revoked_at_ms,
  };
}
