/**
 * Email verification + password reset use-case tests with fake ports. A fake
 * MailComposer puts the raw token in `message.text`, and a fake EmailSender
 * captures it — so the test can drive verify/reset exactly as a user would.
 */
import { describe, it, expect } from 'vitest';
import { type Clock, type IdGen, type AccountId, asAccountId } from '@cloudstudio/cloud-kernel';
import {
  Account,
  SendVerificationEmailUseCase,
  VerifyEmailUseCase,
  RequestPasswordResetUseCase,
  ResetPasswordUseCase,
  ChangePasswordUseCase,
  type AccountRepo,
  type EmailSender,
  type MailComposer,
  type MailMessage,
  type NewAccount,
  type OneTimeTokenPurpose,
  type OneTimeTokenRepo,
  type OpaqueTokenFactory,
  type PasswordHasher,
  type RefreshTokenRepo,
  type SessionRepo,
} from '@cloudstudio/cloud-identity';

let seq = 0;
let nowMs = 1_700_000_000_000;
const ids: IdGen = { uuid: () => `id_${++seq}`, slug: () => `s_${++seq}` };
const clock: Clock = { now: () => nowMs, isoNow: () => new Date(nowMs).toISOString() };
const opaque: OpaqueTokenFactory = {
  issue: async () => {
    const token = `tk_${++seq}`;
    return { token, hash: `h:${token}` };
  },
  hashOf: async (t) => `h:${t}`,
};
const hasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  verify: async () => true,
  needsRehash: () => false,
  dummyVerify: async () => {},
};

let lastMail: MailMessage | null = null;
const sender: EmailSender = {
  async send(m) {
    lastMail = m;
  },
};
// The composer leaks the token into `text` so the test can read it back.
const composer: MailComposer = {
  verification: (to, token) => ({ to, subject: 'verify', html: '', text: token }),
  passwordReset: (to, token) => ({ to, subject: 'reset', html: '', text: token }),
};

class FakeAccountRepo implements AccountRepo {
  store = new Map<string, { id: AccountId; email: string; canon: string; hash: string; verifiedAt: string | null }>();
  private toAccount(r: { id: AccountId; email: string; canon: string; hash: string; verifiedAt: string | null }) {
    return new Account(r.id, r.email, r.canon, 'active', r.verifiedAt, 'now', 'now');
  }
  async findByCanonical(c: string) {
    for (const r of this.store.values()) if (r.canon === c) return this.toAccount(r);
    return null;
  }
  async findById(id: AccountId) {
    const r = this.store.get(id);
    return r ? this.toAccount(r) : null;
  }
  async findCredentialByCanonical(c: string) {
    for (const r of this.store.values()) if (r.canon === c) return { account: this.toAccount(r), passwordHash: r.hash };
    return null;
  }
  async insert(a: NewAccount) {
    this.store.set(a.id, { id: a.id, email: a.email, canon: a.emailCanonical, hash: a.passwordHash, verifiedAt: null });
  }
  async insertOAuth() {}
  async updatePasswordHash(id: AccountId, phc: string) {
    const r = this.store.get(id);
    if (r) r.hash = phc;
  }
  async markEmailVerified(id: AccountId, at: string) {
    const r = this.store.get(id);
    if (r) r.verifiedAt = at;
  }
}

class FakeTokenRepo implements OneTimeTokenRepo {
  rows = new Map<string, { id: string; accountId: AccountId; purpose: OneTimeTokenPurpose; expiresAtMs: number; consumed: boolean }>();
  async create(i: { id: string; accountId: AccountId; purpose: OneTimeTokenPurpose; tokenHash: string; expiresAtMs: number }) {
    this.rows.set(i.tokenHash, { id: i.id, accountId: i.accountId, purpose: i.purpose, expiresAtMs: i.expiresAtMs, consumed: false });
  }
  async findValid(tokenHash: string, purpose: OneTimeTokenPurpose) {
    const r = this.rows.get(tokenHash);
    return r && !r.consumed && r.purpose === purpose && r.expiresAtMs > clock.now() ? { id: r.id, accountId: r.accountId } : null;
  }
  async consume(id: string) {
    for (const r of this.rows.values())
      if (r.id === id) {
        if (r.consumed) return false;
        r.consumed = true;
        return true;
      }
    return false;
  }
  async consumeAllForAccount(accountId: AccountId, purpose: OneTimeTokenPurpose) {
    for (const r of this.rows.values()) if (r.accountId === accountId && r.purpose === purpose) r.consumed = true;
  }
}

let sessionsRevoked = 0;
let refreshRevoked = 0;
const sessions = { async revokeAllForAccount() { sessionsRevoked += 1; } } as unknown as SessionRepo;
const refresh = { async revokeByAccount() { refreshRevoked += 1; } } as unknown as RefreshTokenRepo;

function build() {
  const accounts = new FakeAccountRepo();
  const tokens = new FakeTokenRepo();
  return {
    accounts,
    tokens,
    sendVerification: new SendVerificationEmailUseCase(tokens, opaque, composer, sender, ids, clock),
    verifyEmail: new VerifyEmailUseCase(tokens, opaque, accounts, clock),
    requestReset: new RequestPasswordResetUseCase(accounts, tokens, opaque, composer, sender, ids, clock),
    resetPassword: new ResetPasswordUseCase(accounts, tokens, opaque, hasher, sessions, refresh, clock),
  };
}

describe('email verification + password reset', () => {
  it('sends a verification email and verifies the account from the token', async () => {
    const t = build();
    const id = asAccountId('acc1');
    t.accounts.store.set('acc1', { id, email: 'u@e.com', canon: 'u@e.com', hash: 'hashed:x', verifiedAt: null });
    lastMail = null;
    await t.sendVerification.execute({ accountId: id, email: 'u@e.com' });
    expect(lastMail?.to).toBe('u@e.com');
    const token = lastMail!.text;
    const r = await t.verifyEmail.execute({ token });
    expect(r.ok).toBe(true);
    expect((await t.accounts.findById(id))?.isEmailVerified).toBe(true);
  });

  it('rejects a bad / already-used verification token', async () => {
    const t = build();
    const bad = await t.verifyEmail.execute({ token: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('email_token_invalid');
  });

  it('reset: request emails a token, reset changes the password + revokes sessions', async () => {
    const t = build();
    const id = asAccountId('acc2');
    t.accounts.store.set('acc2', { id, email: 'r@e.com', canon: 'r@e.com', hash: 'hashed:old', verifiedAt: null });
    sessionsRevoked = 0;
    refreshRevoked = 0;
    lastMail = null;
    await t.requestReset.execute({ emailRaw: 'r@e.com' });
    const token = lastMail!.text;

    const r = await t.resetPassword.execute({ token, newPasswordRaw: 'a-brand-new-strong-password' });
    expect(r.ok).toBe(true);
    expect(t.accounts.store.get('acc2')?.hash).toBe('hashed:a-brand-new-strong-password');
    expect(sessionsRevoked).toBe(1);
    expect(refreshRevoked).toBe(1);

    // token is one-shot
    const again = await t.resetPassword.execute({ token, newPasswordRaw: 'yet-another-strong-pass' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('email_token_invalid');
  });

  it('reset request for an unknown email is a silent no-op (no enumeration, no mail)', async () => {
    const t = build();
    lastMail = null;
    const r = await t.requestReset.execute({ emailRaw: 'ghost@e.com' });
    expect(r.ok).toBe(true);
    expect(lastMail).toBeNull();
  });

  it('reset rejects a weak new password', async () => {
    const t = build();
    const id = asAccountId('acc3');
    t.accounts.store.set('acc3', { id, email: 'w@e.com', canon: 'w@e.com', hash: 'hashed:old', verifiedAt: null });
    lastMail = null;
    await t.requestReset.execute({ emailRaw: 'w@e.com' });
    const token = lastMail!.text;
    const r = await t.resetPassword.execute({ token, newPasswordRaw: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('password_too_weak');
  });
});

// A hasher that actually checks `hashed:<plain>`, so the wrong-password path is real.
const realHasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  verify: async (plain, phc) => phc === `hashed:${plain}`,
  needsRehash: () => false,
  dummyVerify: async () => {},
};

describe('ChangePasswordUseCase (authenticated change)', () => {
  function seed() {
    const accounts = new FakeAccountRepo();
    const id = asAccountId('acc-pw');
    accounts.store.set('acc-pw', { id, email: 'p@e.com', canon: 'p@e.com', hash: 'hashed:current-strong-pass', verifiedAt: null });
    const uc = new ChangePasswordUseCase(accounts, realHasher, sessions, refresh, clock);
    sessionsRevoked = 0;
    refreshRevoked = 0;
    return { accounts, id, uc };
  }

  it('rejects a wrong current password (no write, no revoke)', async () => {
    const { accounts, id, uc } = seed();
    const r = await uc.execute({ accountId: id, currentPassword: 'wrong-password', newPasswordRaw: 'a-brand-new-strong-pass' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_credentials');
    expect(accounts.store.get('acc-pw')?.hash).toBe('hashed:current-strong-pass'); // unchanged
    expect(sessionsRevoked).toBe(0);
    expect(refreshRevoked).toBe(0);
  });

  it('rejects a weak new password even with the correct current one', async () => {
    const { uc, id } = seed();
    const r = await uc.execute({ accountId: id, currentPassword: 'current-strong-pass', newPasswordRaw: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('password_too_weak');
    expect(sessionsRevoked).toBe(0);
  });

  it('changes the password and revokes every session + refresh token', async () => {
    const { accounts, id, uc } = seed();
    const r = await uc.execute({ accountId: id, currentPassword: 'current-strong-pass', newPasswordRaw: 'a-brand-new-strong-pass' });
    expect(r.ok).toBe(true);
    expect(accounts.store.get('acc-pw')?.hash).toBe('hashed:a-brand-new-strong-pass');
    expect(sessionsRevoked).toBe(1);
    expect(refreshRevoked).toBe(1);
  });

  it('rejects when the account does not exist', async () => {
    const { uc } = seed();
    const r = await uc.execute({ accountId: asAccountId('ghost'), currentPassword: 'x', newPasswordRaw: 'a-brand-new-strong-pass' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_credentials');
  });
});
