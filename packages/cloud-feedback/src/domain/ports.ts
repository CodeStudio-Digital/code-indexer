/** Feedback ports — D1 behind FeedbackRepo; R2 behind AttachmentStore; CF
 *  Turnstile behind BotVerifier; magic-byte detection behind ContentSniffer. */
import type { AccountId, FeedbackTicketId } from '@cloudstudio/cloud-kernel';
import type { AttachmentKind, FeedbackAttachment, FeedbackSummary, FeedbackTicket } from './feedback.js';

export interface FeedbackRepo {
  insert(ticket: FeedbackTicket): Promise<void>;
  listByAccount(accountId: AccountId): Promise<FeedbackSummary[]>;
  insertAttachment(att: FeedbackAttachment): Promise<void>;
  /** Returns only the attachments owned by `accountId` among `ids` (ownership filter). */
  findOwnedAttachments(ids: readonly string[], accountId: AccountId): Promise<FeedbackAttachment[]>;
}

export interface AttachmentStore {
  /** Stream/store the bytes at `key`; throws on failure (→ storage_unavailable). */
  put(key: string, body: ArrayBuffer, meta: { contentType: string }): Promise<void>;
}

export interface BotVerifier {
  /** Whether Turnstile (or equivalent) is wired. false ⇒ anonymous submit is disabled. */
  readonly enabled: boolean;
  verify(token: string, ip: string | null): Promise<boolean>;
}

export interface SniffResult {
  contentType: string;
  kind: AttachmentKind;
}
export interface ContentSniffer {
  /** Magic-byte detection over the first bytes. null ⇒ reject (unknown/forbidden). */
  sniff(head: Uint8Array): SniffResult | null;
}
