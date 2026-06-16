/** Feedback domain — a user-submitted bug/idea/report with optional attachments
 *  and a triage lifecycle. PII (raw IP/email) is never stored; only salted hashes. */
import type { AccountId, FeedbackTicketId } from '@cloudstudio/cloud-kernel';

export type FeedbackKind = 'bug' | 'idea' | 'other';
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'other'];

/** open → triaged → resolved|wontfix; spam is admin-only + hidden from list-own. */
export type FeedbackStatus = 'open' | 'triaged' | 'resolved' | 'wontfix' | 'spam';

export type AttachmentKind = 'image' | 'text' | 'diagnostic-json';

export type Submitter =
  | { kind: 'account'; accountId: AccountId }
  | { kind: 'anonymous'; ipHash: string; emailHash: string | null };

export interface FeedbackTicket {
  id: FeedbackTicketId;
  publicId: string; // short, non-enumerable (e.g. "fb_x9k2…")
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string; // redacted, ≤ 4000 chars
  submitter: Submitter;
  appVersion: string | null;
  os: string | null; // compact "win32/26200/x64"
  sessionShareId: string | null; // points at a Phase-4 signed share (repro), never raw transcript
  attachmentIds: string[];
  createdAtMs: number;
}

export interface FeedbackAttachment {
  id: string;
  accountId: AccountId; // attachments require auth (abuse-surface reduction)
  r2Key: string; // server-generated; never derived from user input
  contentType: string; // sniffed, from the allowlist
  kind: AttachmentKind;
  byteSize: number;
  createdAtMs: number;
}

/** Summary shape returned by list-own (no forensic columns, no message body trimming). */
export interface FeedbackSummary {
  publicId: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  appVersion: string | null;
  attachmentCount: number;
  createdAtMs: number;
}
