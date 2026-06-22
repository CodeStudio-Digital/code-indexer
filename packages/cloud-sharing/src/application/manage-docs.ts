/** Owner-facing doc management: list own sites + owner-guarded revoke. Revoke of
 *  a non-owned/unknown id returns `doc_not_found` (no existence disclosure). */
import { type Result, ok, err, type AccountId, type Clock } from '@cloudstudio/cloud-kernel';
import { type DocError, DocErrors } from '../domain/doc-errors.js';
import type { DocSiteRepo } from '../domain/doc-ports.js';
import { asDocSiteId, type DocSite } from '../domain/doc-site.js';

export class ListOwnDocsUseCase {
  constructor(private readonly repo: DocSiteRepo) {}
  async execute(input: { ownerAccountId: AccountId }): Promise<DocSite[]> {
    return this.repo.listByOwner(input.ownerAccountId);
  }
}

export class RevokeDocUseCase {
  constructor(
    private readonly repo: DocSiteRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { docId: string; ownerAccountId: AccountId }): Promise<Result<{ revoked: true }, DocError>> {
    const done = await this.repo.revoke(asDocSiteId(input.docId), input.ownerAccountId, this.clock.now());
    return done ? ok({ revoked: true }) : err(DocErrors.notFound());
  }
}
