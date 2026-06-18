/** FeedbackRepo over a DbExecutor (feedback_tickets + feedback_attachments).
 *  Submitter is flattened; list-own hides spam and never returns forensic columns. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import type {
  AttachmentKind,
  FeedbackAttachment,
  FeedbackKind,
  FeedbackRepo,
  FeedbackStatus,
  FeedbackSummary,
  FeedbackTicket,
} from '@cloudstudio/cloud-feedback';

interface AttRow {
  id: string;
  account_id: string;
  r2_key: string;
  content_type: string;
  kind: string;
  byte_size: number;
  created_at_ms: number;
}

export function createFeedbackRepo(db: DbExecutor): FeedbackRepo {
  return {
    async insert(t: FeedbackTicket) {
      const accountId = t.submitter.kind === 'account' ? t.submitter.accountId : null;
      const ipHash = t.submitter.kind === 'anonymous' ? t.submitter.ipHash : null;
      const emailHash = t.submitter.kind === 'anonymous' ? t.submitter.emailHash : null;
      await db.run(
        `INSERT INTO feedback_tickets
         (id, public_id, kind, status, message, submitter_kind, account_id, email_hash, ip_hash, app_version, os, session_share_id, attachment_ids, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.publicId, t.kind, t.status, t.message, t.submitter.kind, accountId, emailHash, ipHash, t.appVersion, t.os, t.sessionShareId, JSON.stringify(t.attachmentIds), t.createdAtMs],
      );
    },

    async listByAccount(accountId: AccountId): Promise<FeedbackSummary[]> {
      const rows = await db.all<{ public_id: string; kind: string; status: string; message: string; app_version: string | null; attachment_ids: string; created_at_ms: number }>(
        `SELECT public_id, kind, status, message, app_version, attachment_ids, created_at_ms
         FROM feedback_tickets WHERE account_id = ? AND status != 'spam' ORDER BY created_at_ms DESC`,
        [accountId],
      );
      return rows.map((r) => ({
        publicId: r.public_id,
        kind: r.kind as FeedbackKind,
        status: r.status as FeedbackStatus,
        message: r.message,
        appVersion: r.app_version,
        attachmentCount: safeLen(r.attachment_ids),
        createdAtMs: r.created_at_ms,
      }));
    },

    async insertAttachment(a: FeedbackAttachment) {
      await db.run(
        'INSERT INTO feedback_attachments (id, account_id, r2_key, content_type, kind, byte_size, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [a.id, a.accountId, a.r2Key, a.contentType, a.kind, a.byteSize, a.createdAtMs],
      );
    },

    async findOwnedAttachments(ids: readonly string[], accountId: AccountId): Promise<FeedbackAttachment[]> {
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      const rows = await db.all<AttRow>(
        `SELECT id, account_id, r2_key, content_type, kind, byte_size, created_at_ms
         FROM feedback_attachments WHERE account_id = ? AND id IN (${placeholders})`,
        [accountId, ...ids],
      );
      return rows.map(toAttachment);
    },
  };
}

function toAttachment(r: AttRow): FeedbackAttachment {
  return {
    id: r.id,
    accountId: asAccountId(r.account_id),
    r2Key: r.r2_key,
    contentType: r.content_type,
    kind: r.kind as AttachmentKind,
    byteSize: r.byte_size,
    createdAtMs: r.created_at_ms,
  };
}

function safeLen(json: string): number {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}
