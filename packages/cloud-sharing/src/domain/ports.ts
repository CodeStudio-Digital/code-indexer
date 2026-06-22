/** Sharing ports — D1 behind ShareRepo; Ed25519 (WebCrypto) behind SnapshotSigner. */
import type { AccountId, ShareId } from '@cloudstudio/cloud-kernel';
import type { PublicShare, Slug } from './share.js';
import type { ShareMessage } from './snapshot.js';

export interface ShareRepo {
  /**
   * Atomically insert the share + its messages ONLY IF the owner has fewer than
   * `maxActiveShares` active shares — the quota check and the insert are one
   * serialized DB operation, so concurrent creates can't race past the limit
   * (no check-then-insert TOCTOU). Returns false when the quota is full.
   */
  insertIfUnderQuota(share: PublicShare, messages: ShareMessage[], maxActiveShares: number): Promise<boolean>;
  findBySlug(slug: Slug): Promise<PublicShare | null>;
  loadMessages(id: ShareId): Promise<ShareMessage[]>;
  listByOwner(owner: AccountId): Promise<PublicShare[]>;
  /** Owner-guarded soft revoke. Returns false if not found or not owned. */
  revoke(id: ShareId, owner: AccountId, atMs: number): Promise<boolean>;
}

export interface SnapshotSigner {
  /** Sign over sha-256(canonical); returns the hex digest + base64 signature. */
  sign(canonical: Uint8Array): Promise<{ sha256: string; signature: string }>;
}

/** What the caller's subscription unlocks for sharing (from cloud-billing). */
export interface SharingEntitlement {
  sharing: boolean;
  maxActiveShares: number;
}
