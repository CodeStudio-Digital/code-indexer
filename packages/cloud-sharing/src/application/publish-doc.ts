/**
 * PublishDoc — the hosted-docs publish path. Server-side it: gates on entitlement
 * + quota, RE-REDACTS the (untrusted) client spec (the client strip is a UX pass
 * we never trust), enforces a size cap, signs the exact stored bytes (Ed25519),
 * and inserts the site atomically under quota. The viewer later serves those same
 * bytes verbatim, so signing over them is sufficient (no separate canonicalize).
 */
import { type Result, ok, err, type AccountId, type IdGen, type Clock } from '@cloudstudio/cloud-kernel';
import { type DocError, DocErrors } from '../domain/doc-errors.js';
import { asDocSiteId, type DocSite, type TryItMode } from '../domain/doc-site.js';
import type { DocSiteRepo, DocsEntitlement } from '../domain/doc-ports.js';
import { asSlug, type Visibility } from '../domain/share.js';
import type { SnapshotSigner } from '../domain/ports.js';
import { redactJson, countOperations } from '../redaction/spec-redaction.js';

const MAX_SPEC_BYTES = 1_500_000; // ~1.5 MB of JSON

export interface PublishDocInput {
  ownerAccountId: AccountId;
  title: string;
  description?: string;
  /** An OpenAPI document produced by the client's `exportOpenApi`. */
  spec: unknown;
  visibility: Visibility;
  tryItMode: TryItMode;
  entitlement: DocsEntitlement;
}

export interface PublishDocOutput {
  docId: string;
  slug: string;
  redactionCount: number;
  operationCount: number;
}

export class PublishDocUseCase {
  constructor(
    private readonly repo: DocSiteRepo,
    private readonly signer: SnapshotSigner,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(input: PublishDocInput): Promise<Result<PublishDocOutput, DocError>> {
    if (!input.entitlement.apiDocs) return err(DocErrors.notEntitled());
    if (!input.spec || typeof input.spec !== 'object') return err(DocErrors.invalid('not an object'));

    const { value: redacted, redactionCount } = redactJson(input.spec);
    const specJson = JSON.stringify(redacted);
    const bytes = new TextEncoder().encode(specJson);
    if (bytes.byteLength > MAX_SPEC_BYTES) return err(DocErrors.tooLarge(MAX_SPEC_BYTES));

    const { sha256, signature } = await this.signer.sign(bytes);
    const now = this.clock.now();
    const doc: DocSite = {
      id: asDocSiteId(this.ids.uuid()),
      slug: asSlug(this.ids.slug(21)),
      ownerAccountId: input.ownerAccountId,
      title: input.title.slice(0, 200),
      description: (input.description ?? '').slice(0, 1000),
      visibility: input.visibility,
      status: 'active',
      tryItMode: input.tryItMode,
      specSha256: sha256,
      specSignature: signature,
      operationCount: countOperations(redacted),
      createdAtMs: now,
      updatedAtMs: now,
      revokedAtMs: null,
    };
    const inserted = await this.repo.insertIfUnderQuota(doc, specJson, input.entitlement.maxApiDocs);
    if (!inserted) return err(DocErrors.quotaExceeded(input.entitlement.maxApiDocs));
    return ok({ docId: doc.id, slug: doc.slug, redactionCount, operationCount: doc.operationCount });
  }
}
