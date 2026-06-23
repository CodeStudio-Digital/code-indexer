/**
 * DocSite aggregate — a hosted API documentation page: a redacted, Ed25519-signed
 * OpenAPI spec addressable by an unguessable slug, served as a browsable docs page
 * at `/d/:slug`. It reuses the sharing context's slug/redaction/signer primitives
 * (a doc site is just another "redacted, signed, slug-addressed published artifact"),
 * so it lives alongside PublicShare rather than in a separate package.
 */
import type { AccountId, Brand } from '@cloudstudio/cloud-kernel';
import type { Slug, Visibility } from './share.js';

export type DocSiteId = Brand<string, 'DocSiteId'>;
export const asDocSiteId = (s: string): DocSiteId => s as DocSiteId;

export type DocStatus = 'active' | 'revoked';

/**
 * Where the viewer's "Try it" requests go:
 * - `off`   — read-only docs (no try-it). Zero request surface; the safe default.
 * - `local` — try-it enabled against the servers declared in the spec (useful when
 *             the AUTHOR opens their own docs; a public viewer's browser would hit
 *             its own localhost, so this is author-facing).
 * `proxy` (worker relays the call) is intentionally NOT in this union for v1 — it
 * is the SSRF-sharp edge and is deferred until host-allowlisting + throttling land.
 */
export type TryItMode = 'off' | 'local';

export interface DocSite {
  id: DocSiteId;
  slug: Slug;
  ownerAccountId: AccountId;
  title: string;
  description: string;
  visibility: Visibility;
  status: DocStatus;
  tryItMode: TryItMode;
  /** sha-256 hex of the stored (redacted) spec bytes — integrity anchor. */
  specSha256: string;
  /** base64 Ed25519 signature over the sha-256 digest. */
  specSignature: string;
  /** path × method count, shown in listings. */
  operationCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  revokedAtMs: number | null;
}

/** Live iff active (docs don't expire — owners revoke). */
export function isDocViewable(d: DocSite): boolean {
  return d.status === 'active';
}
