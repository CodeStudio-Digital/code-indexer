/**
 * Hosted-docs use-case tests with fakes: entitlement + quota gates (incl.
 * unlimited = -1), server-side re-redaction of a secret left in the spec, the
 * size cap, owner-guarded revoke, and viewable/revoked/not-found read semantics.
 * No D1, no WebCrypto.
 */
import { describe, it, expect } from 'vitest';
import { type Clock, type IdGen, asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import {
  PublishDocUseCase,
  GetPublicDocUseCase,
  ListOwnDocsUseCase,
  RevokeDocUseCase,
  asSlug,
  countOperations,
  type DocSite,
  type DocSiteId,
  type DocSiteRepo,
  type DocsEntitlement,
  type SnapshotSigner,
} from '@cloudstudio/cloud-sharing';

let seq = 0;
const nowMs = 1_700_000_000_000;
const ids: IdGen = { uuid: () => `id_${++seq}`, slug: () => `slug${++seq}`.padEnd(21, 'x').slice(0, 21) };
const clock: Clock = { now: () => nowMs, isoNow: () => new Date(nowMs).toISOString() };
const signer: SnapshotSigner = { sign: async () => ({ sha256: 'deadbeef', signature: 'c2ln' }) };
const acc = asAccountId('owner1');
const PRO: DocsEntitlement = { apiDocs: true, maxApiDocs: 100 };

function spec(secret = 'plain'): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'My API', version: '1.0.0' },
    paths: {
      '/login': { post: { summary: 'Login', requestBody: { content: { 'application/json': { example: { token: secret } } } } } },
      '/users': { get: { summary: 'List' }, delete: { summary: 'Delete' } },
    },
  };
}

class FakeDocRepo implements DocSiteRepo {
  docs = new Map<string, DocSite>();
  specs = new Map<string, string>();
  async insertIfUnderQuota(doc: DocSite, specJson: string, maxApiDocs: number) {
    if (maxApiDocs >= 0) {
      const active = [...this.docs.values()].filter((d) => d.ownerAccountId === doc.ownerAccountId && d.status === 'active').length;
      if (active >= maxApiDocs) return false;
    }
    this.docs.set(doc.id, doc);
    this.specs.set(doc.id, specJson);
    return true;
  }
  async findBySlug(slug: string) {
    for (const d of this.docs.values()) if (d.slug === slug) return d;
    return null;
  }
  async loadSpecJson(id: DocSiteId) {
    return this.specs.get(id) ?? null;
  }
  async listByOwner(owner: AccountId) {
    return [...this.docs.values()].filter((d) => d.ownerAccountId === owner);
  }
  async revoke(id: DocSiteId, owner: AccountId, atMs: number) {
    const d = this.docs.get(id);
    if (!d || d.ownerAccountId !== owner || d.status !== 'active') return false;
    d.status = 'revoked';
    d.revokedAtMs = atMs;
    return true;
  }
}

function build() {
  const repo = new FakeDocRepo();
  return {
    repo,
    publish: new PublishDocUseCase(repo, signer, ids, clock),
    getPublic: new GetPublicDocUseCase(repo),
    list: new ListOwnDocsUseCase(repo),
    revoke: new RevokeDocUseCase(repo, clock),
  };
}

describe('countOperations', () => {
  it('counts path × HTTP method', () => {
    expect(countOperations(spec())).toBe(3); // post /login + get /users + delete /users
  });
  it('tolerates a malformed spec', () => {
    expect(countOperations(null)).toBe(0);
    expect(countOperations({ paths: 'nope' })).toBe(0);
  });
});

describe('PublishDoc', () => {
  it('rejects when apiDocs is not entitled (free tier)', async () => {
    const t = build();
    const r = await t.publish.execute({ ownerAccountId: acc, title: 'X', spec: spec(), visibility: 'unlisted', tryItMode: 'off', entitlement: { apiDocs: false, maxApiDocs: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('docs_not_entitled');
  });

  it('rejects when the docs quota is reached', async () => {
    const t = build();
    const one: DocsEntitlement = { apiDocs: true, maxApiDocs: 1 };
    await t.publish.execute({ ownerAccountId: acc, title: 'A', spec: spec(), visibility: 'unlisted', tryItMode: 'off', entitlement: one });
    const r = await t.publish.execute({ ownerAccountId: acc, title: 'B', spec: spec(), visibility: 'unlisted', tryItMode: 'off', entitlement: one });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('docs_quota_exceeded');
  });

  it('allows unlimited publishing when maxApiDocs is -1', async () => {
    const t = build();
    const unlimited: DocsEntitlement = { apiDocs: true, maxApiDocs: -1 };
    for (let i = 0; i < 5; i++) {
      const r = await t.publish.execute({ ownerAccountId: acc, title: `D${i}`, spec: spec(), visibility: 'unlisted', tryItMode: 'off', entitlement: unlimited });
      expect(r.ok).toBe(true);
    }
    expect(t.repo.docs.size).toBe(5);
  });

  it('RE-REDACTS a secret the client left in the spec', async () => {
    const t = build();
    const r = await t.publish.execute({
      ownerAccountId: acc,
      title: 'My API',
      spec: spec('sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ'),
      visibility: 'public',
      tryItMode: 'local',
      entitlement: PRO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.redactionCount).toBeGreaterThanOrEqual(1);
    expect(r.value.operationCount).toBe(3);
    const stored = t.repo.specs.get(r.value.docId)!;
    expect(stored).not.toContain('sk-ant-api03');
    const doc = t.repo.docs.get(r.value.docId)!;
    expect(doc.specSignature).toBe('c2ln');
    expect(doc.tryItMode).toBe('local');
  });

  it('rejects an oversized spec', async () => {
    const t = build();
    const big = { openapi: '3.1.0', info: { title: 'big', version: '1' }, paths: {}, blob: 'a'.repeat(1_600_000) };
    const r = await t.publish.execute({ ownerAccountId: acc, title: 'big', spec: big, visibility: 'unlisted', tryItMode: 'off', entitlement: PRO });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('spec_too_large');
  });

  it('rejects a non-object spec', async () => {
    const t = build();
    const r = await t.publish.execute({ ownerAccountId: acc, title: 'x', spec: 'nope', visibility: 'unlisted', tryItMode: 'off', entitlement: PRO });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('spec_invalid');
  });
});

describe('GetPublicDoc + revoke', () => {
  it('returns a viewable doc, then 410 after revoke', async () => {
    const t = build();
    const created = await t.publish.execute({ ownerAccountId: acc, title: 'My API', spec: spec(), visibility: 'public', tryItMode: 'off', entitlement: PRO });
    if (!created.ok) throw new Error('setup');
    const slug = asSlug(created.value.slug);

    const view = await t.getPublic.execute({ slug });
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.value.title).toBe('My API');
      expect(JSON.parse(view.value.specJson).openapi).toBe('3.1.0');
    }

    const rev = await t.revoke.execute({ docId: created.value.docId, ownerAccountId: acc });
    expect(rev.ok).toBe(true);
    const after = await t.getPublic.execute({ slug });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('doc_revoked');
  });

  it('unknown slug → doc_not_found', async () => {
    const t = build();
    const r = await t.getPublic.execute({ slug: asSlug('doesnotexist000000000') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('doc_not_found');
  });

  it('revoke by a non-owner → doc_not_found (no existence disclosure)', async () => {
    const t = build();
    const created = await t.publish.execute({ ownerAccountId: acc, title: 'x', spec: spec(), visibility: 'unlisted', tryItMode: 'off', entitlement: PRO });
    if (!created.ok) throw new Error('setup');
    const r = await t.revoke.execute({ docId: created.value.docId, ownerAccountId: asAccountId('intruder') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('doc_not_found');
    const listed = await t.list.execute({ ownerAccountId: acc });
    expect(listed.length).toBe(1);
  });
});
