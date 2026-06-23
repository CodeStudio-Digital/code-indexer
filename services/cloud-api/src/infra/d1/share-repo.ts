/** ShareRepo over a DbExecutor (public_shares + public_share_messages).
 *  Insert is atomic via .batch(); the public viewer reads only the denormalized
 *  messages. Timestamps are epoch ms. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId, asShareId, type AccountId, type ShareId } from '@cloudstudio/cloud-kernel';
import {
  asSlug,
  type PublicShare,
  type ShareMessage,
  type ShareRepo,
  type ShareStatus,
  type Visibility,
} from '@cloudstudio/cloud-sharing';

interface ShareRow {
  id: string;
  slug: string;
  owner_account_id: string;
  title: string;
  model: string | null;
  visibility: string;
  status: string;
  snapshot_sha256: string;
  snapshot_signature: string;
  message_count: number;
  created_at_ms: number;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
}

const COLS =
  'id, slug, owner_account_id, title, model, visibility, status, snapshot_sha256, snapshot_signature, message_count, created_at_ms, expires_at_ms, revoked_at_ms';

export function createShareRepo(db: DbExecutor): ShareRepo {
  return {
    async insertIfUnderQuota(share: PublicShare, messages: ShareMessage[], maxActiveShares: number) {
      // Conditional insert: the COUNT subquery + INSERT run as ONE serialized D1
      // statement, so the quota can't be raced. rowsAffected === 0 ⇒ quota full.
      const res = await db.run(
        `INSERT INTO public_shares (${COLS})
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM public_shares WHERE owner_account_id = ? AND status = 'active') < ?`,
        [
          share.id, share.slug, share.ownerAccountId, share.title, share.model, share.visibility, share.status,
          share.snapshotSha256, share.snapshotSignature, share.messageCount, share.createdAtMs, share.expiresAtMs, share.revokedAtMs,
          share.ownerAccountId, maxActiveShares,
        ],
      );
      if (res.rowsAffected === 0) return false;
      if (messages.length) {
        await db.batch(
          messages.map((m) => ({
            sql: 'INSERT INTO public_share_messages (share_id, idx, role, blocks_json) VALUES (?, ?, ?, ?)',
            params: [share.id, m.idx, m.role, JSON.stringify(m.blocks)],
          })),
        );
      }
      return true;
    },

    async findBySlug(slug) {
      const row = await db.first<ShareRow>(`SELECT ${COLS} FROM public_shares WHERE slug = ?`, [slug]);
      return row ? toShare(row) : null;
    },

    async loadMessages(id: ShareId) {
      const rows = await db.all<{ idx: number; role: string; blocks_json: string }>(
        'SELECT idx, role, blocks_json FROM public_share_messages WHERE share_id = ? ORDER BY idx',
        [id],
      );
      return rows.map((r) => ({ idx: r.idx, role: r.role as ShareMessage['role'], blocks: JSON.parse(r.blocks_json) }));
    },

    async listByOwner(owner: AccountId) {
      const rows = await db.all<ShareRow>(
        `SELECT ${COLS} FROM public_shares WHERE owner_account_id = ? ORDER BY created_at_ms DESC`,
        [owner],
      );
      return rows.map(toShare);
    },

    async revoke(id: ShareId, owner: AccountId, atMs: number) {
      const res = await db.run(
        "UPDATE public_shares SET status = 'revoked', revoked_at_ms = ? WHERE id = ? AND owner_account_id = ? AND status = 'active'",
        [atMs, id, owner],
      );
      return res.rowsAffected > 0;
    },
  };
}

function toShare(r: ShareRow): PublicShare {
  return {
    id: asShareId(r.id),
    slug: asSlug(r.slug),
    ownerAccountId: asAccountId(r.owner_account_id),
    title: r.title,
    model: r.model,
    visibility: r.visibility as Visibility,
    status: r.status as ShareStatus,
    snapshotSha256: r.snapshot_sha256,
    snapshotSignature: r.snapshot_signature,
    messageCount: r.message_count,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
    revokedAtMs: r.revoked_at_ms,
  };
}
