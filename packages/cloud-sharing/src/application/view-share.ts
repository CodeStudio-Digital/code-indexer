/** Public read path (no auth) + owner management (list / revoke). */
import { type Result, ok, err, type AccountId, type Clock, type ShareId } from '@cloudstudio/cloud-kernel';
import { type ShareError, ShareErrors } from '../domain/errors.js';
import { isViewable, type PublicShare, type Slug, type Visibility } from '../domain/share.js';
import type { ShareMessage } from '../domain/snapshot.js';
import type { ShareRepo } from '../domain/ports.js';

export interface PublicShareView {
  title: string;
  model: string | null;
  visibility: Visibility;
  createdAtMs: number;
  messages: ShareMessage[];
  integrity: { sha256: string; signature: string };
}

export class GetPublicShareUseCase {
  constructor(
    private readonly repo: ShareRepo,
    private readonly clock: Clock,
  ) {}

  async execute(input: { slug: Slug }): Promise<Result<PublicShareView, ShareError>> {
    const share = await this.repo.findBySlug(input.slug);
    if (!share) return err(ShareErrors.notFound());
    if (!isViewable(share, this.clock.now())) {
      return err(share.status === 'revoked' ? ShareErrors.revoked() : ShareErrors.expired());
    }
    const messages = await this.repo.loadMessages(share.id);
    return ok({
      title: share.title,
      model: share.model,
      visibility: share.visibility,
      createdAtMs: share.createdAtMs,
      messages,
      integrity: { sha256: share.snapshotSha256, signature: share.snapshotSignature },
    });
  }
}

export class ListOwnSharesUseCase {
  constructor(private readonly repo: ShareRepo) {}
  async execute(input: { ownerAccountId: AccountId }): Promise<PublicShare[]> {
    return this.repo.listByOwner(input.ownerAccountId);
  }
}

export class RevokeShareUseCase {
  constructor(
    private readonly repo: ShareRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { shareId: ShareId; ownerAccountId: AccountId }): Promise<Result<{ revoked: true }, ShareError>> {
    // Returns 404 (not 403) to a non-owner so we never disclose a share exists.
    const done = await this.repo.revoke(input.shareId, input.ownerAccountId, this.clock.now());
    return done ? ok({ revoked: true }) : err(ShareErrors.notFound());
  }
}
