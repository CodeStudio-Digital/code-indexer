/**
 * Sharing use-case tests with fakes: entitlement + quota gates, server-side
 * re-redaction on publish, owner-guarded revoke, and viewable/revoked/expired
 * read semantics. No D1, no WebCrypto.
 */
import { describe, it, expect } from 'vitest';
import { type Clock, type IdGen, asAccountId, asShareId, type AccountId, type ShareId } from '@cloudstudio/cloud-kernel';
import {
  CreateShareUseCase,
  GetPublicShareUseCase,
  ListOwnSharesUseCase,
  RevokeShareUseCase,
  asSlug,
  type PublicShare,
  type ShareMessage,
  type ShareRepo,
  type ShareSnapshot,
  type SharingEntitlement,
  type SnapshotSigner,
} from '@cloudstudio/cloud-sharing';

let seq = 0;
let nowMs = 1_700_000_000_000;
const ids: IdGen = { uuid: () => `id_${++seq}`, slug: () => `slug${++seq}xxxxxxxxxxxxx` };
const clock: Clock = { now: () => nowMs, isoNow: () => new Date(nowMs).toISOString() };
const signer: SnapshotSigner = { sign: async () => ({ sha256: 'deadbeef', signature: 'c2ln' }) };
const acc = asAccountId('owner1');
const PRO: SharingEntitlement = { sharing: true, maxActiveShares: 100 };

function snapshot(text = 'hello world'): ShareSnapshot {
  return { schemaVersion: 1, title: 'My chat', model: 'm', createdAtMs: nowMs, messages: [{ idx: 0, role: 'user', blocks: [{ type: 'text', text }] }] };
}

class FakeShareRepo implements ShareRepo {
  shares = new Map<string, PublicShare>(); // by id
  msgs = new Map<string, ShareMessage[]>();
  async insertIfUnderQuota(share: PublicShare, messages: ShareMessage[], maxActiveShares: number) {
    const active = [...this.shares.values()].filter((s) => s.ownerAccountId === share.ownerAccountId && s.status === 'active').length;
    if (active >= maxActiveShares) return false;
    this.shares.set(share.id, share);
    this.msgs.set(share.id, messages);
    return true;
  }
  async findBySlug(slug: string) {
    for (const s of this.shares.values()) if (s.slug === slug) return s;
    return null;
  }
  async loadMessages(id: ShareId) {
    return this.msgs.get(id) ?? [];
  }
  async listByOwner(owner: AccountId) {
    return [...this.shares.values()].filter((s) => s.ownerAccountId === owner);
  }
  async revoke(id: ShareId, owner: AccountId, atMs: number) {
    const s = this.shares.get(id);
    if (!s || s.ownerAccountId !== owner || s.status !== 'active') return false;
    s.status = 'revoked';
    s.revokedAtMs = atMs;
    return true;
  }
}

function build() {
  const repo = new FakeShareRepo();
  return {
    repo,
    create: new CreateShareUseCase(repo, signer, ids, clock),
    getPublic: new GetPublicShareUseCase(repo, clock),
    list: new ListOwnSharesUseCase(repo),
    revoke: new RevokeShareUseCase(repo, clock),
  };
}

describe('CreateShare', () => {
  it('rejects when sharing is not entitled (free tier)', async () => {
    const t = build();
    const r = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'unlisted', expiresInDays: null, entitlement: { sharing: false, maxActiveShares: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('sharing_not_entitled');
  });

  it('rejects when the active-share quota is reached', async () => {
    const t = build();
    await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'unlisted', expiresInDays: null, entitlement: { sharing: true, maxActiveShares: 1 } });
    const r = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'unlisted', expiresInDays: null, entitlement: { sharing: true, maxActiveShares: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('share_quota_exceeded');
  });

  it('publishes a share and RE-REDACTS a secret the client left in', async () => {
    const t = build();
    const r = await t.create.execute({
      ownerAccountId: acc,
      snapshot: snapshot('leaking sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ here'),
      visibility: 'unlisted',
      expiresInDays: 7,
      entitlement: PRO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.redactionCount).toBeGreaterThanOrEqual(1);
    const stored = t.repo.msgs.get(r.value.shareId)!;
    expect(JSON.stringify(stored)).not.toContain('sk-ant-api03');
    const share = t.repo.shares.get(r.value.shareId)!;
    expect(share.expiresAtMs).toBe(nowMs + 7 * 86_400_000);
    expect(share.snapshotSignature).toBe('c2ln');
  });

  it('rejects an oversized snapshot', async () => {
    const t = build();
    const r = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot('a'.repeat(1_600_000)), visibility: 'unlisted', expiresInDays: null, entitlement: PRO });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('snapshot_too_large');
  });
});

describe('GetPublicShare + revoke', () => {
  it('returns a viewable share, then 410 after revoke', async () => {
    const t = build();
    const created = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'public', expiresInDays: null, entitlement: PRO });
    if (!created.ok) throw new Error('setup');
    const slug = asSlug(created.value.slug);

    const view = await t.getPublic.execute({ slug });
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.value.title).toBe('My chat');

    const rev = await t.revoke.execute({ shareId: asShareId(created.value.shareId), ownerAccountId: acc });
    expect(rev.ok).toBe(true);
    const after = await t.getPublic.execute({ slug });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('share_revoked');
  });

  it('unknown slug → share_not_found', async () => {
    const t = build();
    const r = await t.getPublic.execute({ slug: asSlug('doesnotexist0000000000') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('share_not_found');
  });

  it('expired share → share_expired', async () => {
    const t = build();
    const created = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'unlisted', expiresInDays: 1, entitlement: PRO });
    if (!created.ok) throw new Error('setup');
    nowMs += 2 * 86_400_000; // jump past expiry
    const r = await t.getPublic.execute({ slug: asSlug(created.value.slug) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('share_expired');
    nowMs = 1_700_000_000_000; // reset for other tests
  });

  it('revoke by a non-owner → share_not_found (no existence disclosure)', async () => {
    const t = build();
    const created = await t.create.execute({ ownerAccountId: acc, snapshot: snapshot(), visibility: 'unlisted', expiresInDays: null, entitlement: PRO });
    if (!created.ok) throw new Error('setup');
    const r = await t.revoke.execute({ shareId: asShareId(created.value.shareId), ownerAccountId: asAccountId('intruder') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('share_not_found');

    const listed = await t.list.execute({ ownerAccountId: acc });
    expect(listed.length).toBe(1);
  });
});
