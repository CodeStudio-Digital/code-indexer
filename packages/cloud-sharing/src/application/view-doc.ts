/** GetPublicDoc — the no-auth viewer read. Returns the doc metadata + the stored
 *  (already-redacted) spec JSON string, served verbatim. Revoked → 410. */
import { type Result, ok, err } from '@cloudstudio/cloud-kernel';
import { type DocError, DocErrors } from '../domain/doc-errors.js';
import type { DocSiteRepo } from '../domain/doc-ports.js';
import type { TryItMode } from '../domain/doc-site.js';
import type { Slug } from '../domain/share.js';

export interface PublicDocView {
  slug: string;
  title: string;
  description: string;
  tryItMode: TryItMode;
  operationCount: number;
  specSha256: string;
  specSignature: string;
  /** The raw stored spec JSON string (already redacted). */
  specJson: string;
}

export class GetPublicDocUseCase {
  constructor(private readonly repo: DocSiteRepo) {}

  async execute(input: { slug: Slug }): Promise<Result<PublicDocView, DocError>> {
    const doc = await this.repo.findBySlug(input.slug);
    if (!doc) return err(DocErrors.notFound());
    if (doc.status === 'revoked') return err(DocErrors.revoked());
    const specJson = await this.repo.loadSpecJson(doc.id);
    if (specJson == null) return err(DocErrors.notFound());
    return ok({
      slug: doc.slug,
      title: doc.title,
      description: doc.description,
      tryItMode: doc.tryItMode,
      operationCount: doc.operationCount,
      specSha256: doc.specSha256,
      specSignature: doc.specSignature,
      specJson,
    });
  }
}
