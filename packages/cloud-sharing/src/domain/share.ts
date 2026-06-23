/** PublicShare aggregate — an immutable, redacted, signed snapshot of a
 *  conversation, addressable by an unguessable slug. */
import type { AccountId, Brand, ShareId } from '@cloudstudio/cloud-kernel';

export type Slug = Brand<string, 'Slug'>;
/** 21 url-safe chars ≈ 125 bits — not enumerable. */
export const SLUG_RE = /^[0-9A-Za-z_-]{21}$/;
export const isSlug = (s: string): s is Slug => SLUG_RE.test(s);
export const asSlug = (s: string): Slug => s as Slug;

export type Visibility = 'public' | 'unlisted';
export type ShareStatus = 'active' | 'revoked' | 'expired';

export interface PublicShare {
  id: ShareId;
  slug: Slug;
  ownerAccountId: AccountId;
  title: string;
  model: string | null; // "provider/model" label shown in the viewer; never creds
  visibility: Visibility;
  status: ShareStatus;
  /** sha-256 hex of the canonical snapshot (integrity anchor). */
  snapshotSha256: string;
  /** base64 Ed25519 signature over the sha-256 digest. */
  snapshotSignature: string;
  messageCount: number;
  createdAtMs: number;
  /** epoch ms; null = never expires. */
  expiresAtMs: number | null;
  revokedAtMs: number | null;
}

/** Live iff active and not past its expiry. Revoked/expired links are "gone". */
export function isViewable(s: PublicShare, nowMs: number): boolean {
  if (s.status !== 'active') return false;
  return s.expiresAtMs == null || s.expiresAtMs > nowMs;
}
