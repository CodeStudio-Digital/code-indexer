/** ResolveOAuthIdentityUseCase — the security-critical linking rules. */
import { describe, it, expect, beforeEach } from 'vitest';
import { asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import { Account } from '../domain/account.js';
import type { AccountRepo, NewAccount, NewOAuthAccount, OAuthIdentityRepo, NewOAuthIdentity } from '../domain/ports.js';
import { ResolveOAuthIdentityUseCase, type OAuthProfile } from '../application/oauth-link.js';

const NOW = '2026-06-22T00:00:00.000Z';
let counter = 0;
const ids = { uuid: () => `id-${++counter}`, slug: (size = 22) => 'x'.repeat(size) };
const clock = { now: () => 0, isoNow: () => NOW };

class FakeAccountRepo implements AccountRepo {
  byId = new Map<string, Account>();
  byCanonical = new Map<string, Account>();
  /** seed a pre-existing password account */
  seed(id: string, email: string, opts: { verified?: boolean; status?: 'active' | 'locked' | 'deleted' } = {}) {
    const a = new Account(
      asAccountId(id),
      email,
      email.toLowerCase(),
      opts.status ?? 'active',
      opts.verified ? NOW : null,
      NOW,
      NOW,
    );
    this.byId.set(id, a);
    this.byCanonical.set(email.toLowerCase(), a);
    return a;
  }
  async findByCanonical(c: string) {
    return this.byCanonical.get(c) ?? null;
  }
  async findById(id: AccountId) {
    return this.byId.get(id) ?? null;
  }
  async findCredentialByCanonical() {
    return null;
  }
  async insert(_a: NewAccount) {}
  async insertOAuth(a: NewOAuthAccount) {
    if (this.byCanonical.has(a.emailCanonical)) throw new Error('UNIQUE');
    const acct = new Account(a.id, a.email, a.emailCanonical, 'active', a.emailVerifiedAt, NOW, NOW);
    this.byId.set(a.id, acct);
    this.byCanonical.set(a.emailCanonical, acct);
  }
  async updatePasswordHash() {}
  async markEmailVerified() {}
}

class FakeIdentityRepo implements OAuthIdentityRepo {
  links = new Map<string, AccountId>();
  async findByProviderUser(provider: string, sub: string) {
    const accountId = this.links.get(`${provider}:${sub}`);
    return accountId ? { accountId } : null;
  }
  async link(i: NewOAuthIdentity) {
    this.links.set(`${i.provider}:${i.providerUserId}`, i.accountId);
  }
}

let accounts: FakeAccountRepo;
let identities: FakeIdentityRepo;
let uc: ResolveOAuthIdentityUseCase;
beforeEach(() => {
  counter = 0;
  accounts = new FakeAccountRepo();
  identities = new FakeIdentityRepo();
  uc = new ResolveOAuthIdentityUseCase(accounts, identities, ids, clock);
});

const profile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
  provider: 'github',
  providerUserId: 'gh-123',
  email: 'a@example.com',
  emailVerified: true,
  name: 'A',
  ...over,
});

describe('ResolveOAuthIdentityUseCase', () => {
  it('(a) returns the linked account on a known subject, ignoring email changes', async () => {
    const seeded = accounts.seed('acct-1', 'old@example.com', { verified: true });
    identities.links.set('github:gh-123', seeded.id);
    const r = await uc.execute(profile({ email: 'totally-new@example.com', emailVerified: true }));
    expect(r.ok && r.value.outcome).toBe('linked_existing');
    expect(r.ok && r.value.account.id).toBe('acct-1');
  });

  it('(b) auto-links to an existing account on a VERIFIED matching email', async () => {
    const seeded = accounts.seed('acct-9', 'a@example.com', { verified: true });
    const r = await uc.execute(profile({ emailVerified: true }));
    expect(r.ok && r.value.outcome).toBe('matched_email');
    expect(r.ok && r.value.account.id).toBe('acct-9');
    // the link is now persisted
    expect(await identities.findByProviderUser('github', 'gh-123')).toEqual({ accountId: seeded.id });
  });

  it('(b-negated) an UNVERIFIED, non-colliding email creates a new UNVERIFIED account', async () => {
    const r = await uc.execute(profile({ email: 'solo@example.com', emailVerified: false }));
    expect(r.ok && r.value.outcome).toBe('created');
    // the new account is UNVERIFIED (provider didn't assert it)
    expect(r.ok && r.value.account.isEmailVerified).toBe(false);
  });

  it('(b-negated, GitHub gotcha) an UNVERIFIED email matching a victim REFUSES — no link, no dup', async () => {
    accounts.seed('victim', 'a@example.com', { verified: true });
    const r = await uc.execute(profile({ emailVerified: false }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('email_already_registered');
    // the victim was never linked
    expect(await identities.findByProviderUser('github', 'gh-123')).toBeNull();
  });

  it('(c) creates a fresh verified account when no link and no existing email', async () => {
    const r = await uc.execute(profile({ email: 'fresh@example.com', emailVerified: true }));
    expect(r.ok && r.value.outcome).toBe('created');
    expect(r.ok && r.value.account.email).toBe('fresh@example.com');
    expect(r.ok && r.value.account.isEmailVerified).toBe(true);
  });

  it('errors when the provider shares no email and there is no link', async () => {
    const r = await uc.execute(profile({ email: null, emailVerified: false }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('oauth_no_email');
  });

  it('rejects a locked linked account', async () => {
    const seeded = accounts.seed('locked-1', 'l@example.com', { status: 'locked' });
    identities.links.set('github:gh-123', seeded.id);
    const r = await uc.execute(profile());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('account_locked');
  });
});
