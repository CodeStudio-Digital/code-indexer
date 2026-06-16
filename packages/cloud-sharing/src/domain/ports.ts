/** Sharing ports — D1 behind ShareRepo; Ed25519 (WebCrypto) behind SnapshotSigner. */
import type { AccountId, ShareId } from '@cloudstudio/cloud-kernel';
import type { PublicShare, Slug } from './share.js';
import type { ShareMessage } from './snapshot.js';

export interface ShareRepo {
  /** Atomic: the share row + its denormalized messages in one transaction. */
  insert(share: PublicShare, messages: ShareMessage[]): Promise<void>;
  findBySlug(slug: Slug): Promise<PublicShare | null>;
  loadMessages(id: ShareId): Promise<ShareMessage[]>;
  countActiveByOwner(owner: AccountId): Promise<number>;
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
