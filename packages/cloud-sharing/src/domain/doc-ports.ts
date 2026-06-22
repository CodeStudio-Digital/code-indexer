/** Hosted-docs ports — D1 behind DocSiteRepo; signing reuses the sharing
 *  SnapshotSigner (Ed25519 over a sha-256 digest). */
import type { AccountId } from '@cloudstudio/cloud-kernel';
import type { DocSite, DocSiteId } from './doc-site.js';
import type { Slug } from './share.js';

export interface DocSiteRepo {
  /**
   * Atomically insert the doc site (with its spec JSON) ONLY IF the owner has
   * fewer than `maxApiDocs` active sites — quota check + insert as one serialized
   * DB op (no TOCTOU). `maxApiDocs < 0` means unlimited. Returns false when full.
   */
  insertIfUnderQuota(doc: DocSite, specJson: string, maxApiDocs: number): Promise<boolean>;
  findBySlug(slug: Slug): Promise<DocSite | null>;
  /** The raw stored (redacted) spec JSON string, served verbatim to the viewer. */
  loadSpecJson(id: DocSiteId): Promise<string | null>;
  listByOwner(owner: AccountId): Promise<DocSite[]>;
  /** Owner-guarded soft revoke. Returns false if not found or not owned. */
  revoke(id: DocSiteId, owner: AccountId, atMs: number): Promise<boolean>;
}

/** What the caller's subscription unlocks for hosted docs (from cloud-billing). */
export interface DocsEntitlement {
  apiDocs: boolean;
  /** -1 = unlimited. */
  maxApiDocs: number;
}
