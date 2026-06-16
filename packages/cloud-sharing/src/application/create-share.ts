/**
 * CreateShare — the publish path. Server-side it: gates on entitlement + quota,
 * RE-REDACTS the (untrusted) client snapshot, enforces a size cap, signs the
 * canonical bytes (Ed25519), and stores the share + denormalized messages
 * atomically. The re-redaction is the security boundary — the client pass is a
 * UX preview we never trust.
 */
import { type Result, ok, err, type AccountId, type IdGen, type Clock, asShareId } from '@cloudstudio/cloud-kernel';
import { type ShareError, ShareErrors } from '../domain/errors.js';
import { asSlug, type PublicShare, type Visibility } from '../domain/share.js';
import { canonicalize, type ShareSnapshot } from '../domain/snapshot.js';
import { redactSnapshot } from '../redaction/redactor.js';
import type { ShareRepo, SharingEntitlement, SnapshotSigner } from '../domain/ports.js';

const MAX_SNAPSHOT_BYTES = 1_500_000; // ~1.5 MB of canonical JSON
const DAY_MS = 86_400_000;

export interface CreateShareInput {
  ownerAccountId: AccountId;
  snapshot: ShareSnapshot;
  visibility: Visibility;
  expiresInDays: number | null;
  entitlement: SharingEntitlement;
}

export interface CreateShareOutput {
  shareId: string;
  slug: string;
  redactionCount: number;
}

export class CreateShareUseCase {
  constructor(
    private readonly repo: ShareRepo,
    private readonly signer: SnapshotSigner,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(input: CreateShareInput): Promise<Result<CreateShareOutput, ShareError>> {
    if (!input.entitlement.sharing) return err(ShareErrors.notEntitled());
    const active = await this.repo.countActiveByOwner(input.ownerAccountId);
    if (active >= input.entitlement.maxActiveShares) return err(ShareErrors.quotaExceeded(input.entitlement.maxActiveShares));

    const { value: redacted, redactionCount } = redactSnapshot(input.snapshot, 'standard');
    const canonical = canonicalize(redacted);
    if (canonical.byteLength > MAX_SNAPSHOT_BYTES) return err(ShareErrors.tooLarge(MAX_SNAPSHOT_BYTES));

    const { sha256, signature } = await this.signer.sign(canonical);
    const now = this.clock.now();
    const share: PublicShare = {
      id: asShareId(this.ids.uuid()),
      slug: asSlug(this.ids.slug(21)),
      ownerAccountId: input.ownerAccountId,
      title: redacted.title.slice(0, 200),
      model: redacted.model,
      visibility: input.visibility,
      status: 'active',
      snapshotSha256: sha256,
      snapshotSignature: signature,
      messageCount: redacted.messages.length,
      createdAtMs: now,
      expiresAtMs: input.expiresInDays ? now + input.expiresInDays * DAY_MS : null,
      revokedAtMs: null,
    };
    await this.repo.insert(share, redacted.messages);
    return ok({ shareId: share.id, slug: share.slug, redactionCount });
  }
}
