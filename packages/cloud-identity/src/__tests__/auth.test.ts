/**
 * Identity use-case tests — pure, with FAKE in-memory ports (no D1, no WASM, no
 * server). Locks in the security-critical behaviour: enumeration-safe errors,
 * one-shot refresh rotation, refresh-reuse → family revocation, and logout.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Clock, IdGen, AccountId, SessionId } from '@cloudstudio/cloud-kernel';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import {
  Account,
  SessionIssuer,
  SignupUseCase,
  LoginUseCase,
  RefreshUseCase,
  LogoutUseCase,
  LogoutAllUseCase,
  ListSessionsUseCase,
  type AccessClaims,
  type AccessTokenSigner,
  type AccountRepo,
  type NewAccount,
  type NewRefreshToken,
  type NewSession,
  type OpaqueTokenFactory,
  type PasswordHasher,
  type RefreshTokenRepo,
  type SessionRepo,
  type StoredRefreshToken,
  type LoginThrottle,
  type TwoFactorRepo,
  type ChallengeTokenPort,
} from '@cloudstudio/cloud-identity';

// ── Fakes ────────────────────────────────────────────────────────────────────
let seq = 0;
const idGen: IdGen = { uuid: () => `id_${++seq}`, slug: (n = 8) => `slug_${++seq}`.padEnd(n, '0') };
let nowMs = 1_700_000_000_000;
const clock: Clock = { now: () => nowMs, isoNow: () => new Date(nowMs).toISOString() };

const hasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  verify: async (p, phc) => phc === `hashed:${p}`,
  needsRehash: () => false,
  dummyVerify: async () => {},
};

const signer: AccessTokenSigner = {
  sign: async (input, ttl) => `tok.${input.sub}.${input.sid}.${input.ev}.${clock.now() / 1000 + ttl}`,
  verify: async (token) => {
    const [, sub, sid, ev, exp] = token.split('.');
    if (!sub) return null;
    return { sub, sid, ev: ev === 'true', iat: 0, exp: Number(exp) } as AccessClaims;
  },
};

const opaque: OpaqueTokenFactory = {
  issue: async () => {
    const token = `rt_${++seq}`;
    return { token, hash: `h:${token}` };
  },
  hashOf: async (t) => `h:${t}`,
};

class FakeAccountRepo implements AccountRepo {
  private byCanon = new Map<string, { a: Account; hash: string }>();
  async findByCanonical(c: string) {
    return this.byCanon.get(c)?.a ?? null;
  }
  async findById(id: AccountId) {
    for (const v of this.byCanon.values()) if (v.a.id === id) return v.a;
    return null;
  }
  async findCredentialByCanonical(c: string) {
    const v = this.byCanon.get(c);
    return v ? { account: v.a, passwordHash: v.hash } : null;
  }
  async insert(a: NewAccount) {
    const now = clock.isoNow();
    this.byCanon.set(a.emailCanonical, {
      a: new Account(a.id, a.email, a.emailCanonical, 'active', null, now, now),
      hash: a.passwordHash,
    });
  }
  async updatePasswordHash() {}
  async markEmailVerified() {}
}

class FakeSessionRepo implements SessionRepo {
  private rows = new Map<string, { accountId: AccountId; userAgent: string | null; createdAt: string; revoked: boolean }>();
  async insert(s: NewSession) {
    this.rows.set(s.id, { accountId: s.accountId, userAgent: s.userAgent, createdAt: clock.isoNow(), revoked: false });
  }
  async findActive(id: SessionId) {
    const r = this.rows.get(id);
    return r && !r.revoked ? { id, accountId: r.accountId } : null;
  }
  async touch() {}
  async revoke(id: SessionId) {
    const r = this.rows.get(id);
    if (r) r.revoked = true;
  }
  async listByAccount(accountId: AccountId) {
    const out = [];
    for (const [id, r] of this.rows)
      if (r.accountId === accountId && !r.revoked)
        out.push({ id: asSessionId(id), userAgent: r.userAgent, createdAt: r.createdAt, lastSeenAt: r.createdAt });
    return out;
  }
  async revokeAllForAccount(accountId: AccountId) {
    for (const r of this.rows.values()) if (r.accountId === accountId) r.revoked = true;
  }
}

class FakeRefreshRepo implements RefreshTokenRepo {
  rows = new Map<string, StoredRefreshToken & { tokenHash: string }>();
  async insert(t: NewRefreshToken) {
    this.rows.set(t.id, {
      id: t.id,
      tokenHash: t.tokenHash,
      sessionId: t.sessionId,
      accountId: t.accountId,
      familyId: t.familyId,
      expiresAtIso: t.expiresAtIso,
      consumedAt: null,
      revokedAt: null,
    });
  }
  async findByHash(h: string) {
    for (const r of this.rows.values()) if (r.tokenHash === h) return r;
    return null;
  }
  async consume(id: string, at: string) {
    const r = this.rows.get(id);
    if (r && !r.consumedAt) {
      r.consumedAt = at;
      return true;
    }
    return false;
  }
  async revokeFamily(familyId: string, at: string) {
    for (const r of this.rows.values()) if (r.familyId === familyId && !r.revokedAt) r.revokedAt = at;
  }
  async revokeBySession(sessionId: SessionId, at: string) {
    for (const r of this.rows.values()) if (r.sessionId === sessionId && !r.revokedAt) r.revokedAt = at;
  }
  async revokeByAccount(accountId: AccountId, at: string) {
    for (const r of this.rows.values()) if (r.accountId === accountId && !r.revokedAt) r.revokedAt = at;
  }
}

const noopThrottle = (): LoginThrottle => ({
  async check() {
    return { locked: false, retryAfterMs: 0 };
  },
  async recordFailure() {},
  async recordSuccess() {},
});

// No 2FA enrolled (getSecret → null) → login issues a session directly.
const noopTwoFactor: TwoFactorRepo = {
  async getSecret() {
    return null;
  },
  async upsertPending() {},
  async enable() {},
  async disable() {},
  async addRecoveryCodes() {},
  async consumeRecoveryCode() {
    return false;
  },
};
const noopChallengeTokens: ChallengeTokenPort = {
  async sign() {
    return 'ch';
  },
  async verify() {
    return null;
  },
};

function build(throttle: LoginThrottle = noopThrottle()) {
  const accounts = new FakeAccountRepo();
  const sessions = new FakeSessionRepo();
  const refresh = new FakeRefreshRepo();
  const issuer = new SessionIssuer(sessions, refresh, signer, opaque, idGen, clock);
  return {
    accounts,
    sessions,
    refresh,
    signup: new SignupUseCase(accounts, hasher, issuer, idGen, clock),
    login: new LoginUseCase(accounts, hasher, issuer, throttle, noopTwoFactor, noopChallengeTokens),
    doRefresh: new RefreshUseCase(refresh, sessions, accounts, opaque, issuer, clock),
    logout: new LogoutUseCase(sessions, refresh, clock),
    logoutAll: new LogoutAllUseCase(sessions, refresh, clock),
    listSessions: new ListSessionsUseCase(sessions),
  };
}
const CTX = { userAgent: 'test', ipHash: null };

describe('identity auth', () => {
  beforeEach(() => {
    seq = 0;
    nowMs = 1_700_000_000_000;
  });

  it('signs up, logs in, and rejects duplicates / weak / bad input', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'A@Example.com ', passwordRaw: 'longenoughpassword', ...CTX });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.value.account.email).toBe('A@Example.com');

    const dup = await t.signup.execute({ emailRaw: 'a@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('email_already_registered');

    const weak = await t.signup.execute({ emailRaw: 'b@example.com', passwordRaw: 'short', ...CTX });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.error.code).toBe('password_too_weak');

    const bad = await t.signup.execute({ emailRaw: 'not-an-email', passwordRaw: 'longenoughpassword', ...CTX });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('email_invalid');

    const ok = await t.login.execute({ emailRaw: 'a@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(ok.ok).toBe(true);
    const wrong = await t.login.execute({ emailRaw: 'a@example.com', passwordRaw: 'nope-wrong-pass', ...CTX });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('invalid_credentials');
    const unknown = await t.login.execute({ emailRaw: 'ghost@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('invalid_credentials');
  });

  it('rotates refresh tokens one-shot and revokes the family on reuse', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'r@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(s.ok).toBe(true);
    const first = s.ok ? s.value.session.refreshToken : '';

    const r1 = await t.doRefresh.execute({ refreshToken: first });
    expect(r1.ok).toBe(true);
    const second = r1.ok ? r1.value.session.refreshToken : '';
    expect(second).not.toBe(first);

    const reuse = await t.doRefresh.execute({ refreshToken: first });
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe('token_reuse');

    const afterKill = await t.doRefresh.execute({ refreshToken: second });
    expect(afterKill.ok).toBe(false);
    if (!afterKill.ok) expect(afterKill.error.code).toBe('refresh_invalid');
  });

  it('rejects an expired refresh token', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'e@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    const token = s.ok ? s.value.session.refreshToken : '';
    nowMs += 31 * 24 * 60 * 60 * 1000;
    const r = await t.doRefresh.execute({ refreshToken: token });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('refresh_expired');
  });

  it('rejects an unknown refresh token', async () => {
    const t = build();
    const r = await t.doRefresh.execute({ refreshToken: 'rt_does_not_exist' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('refresh_invalid');
  });

  it('logout revokes the session + its refresh tokens; sessions list flags current', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'l@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const sid = asSessionId(s.value.session.sessionId);
    const accId = asAccountId(s.value.account.id);

    expect(await t.sessions.findActive(sid)).not.toBeNull();
    const list = await t.listSessions.execute({ accountId: accId, currentSessionId: sid });
    expect(list.ok && list.value.length).toBe(1);
    expect(list.ok && list.value[0].current).toBe(true);

    await t.logout.execute({ accountId: accId, sessionId: sid });
    expect(await t.sessions.findActive(sid)).toBeNull();
    const afterLogout = await t.doRefresh.execute({ refreshToken: s.value.session.refreshToken });
    expect(afterLogout.ok).toBe(false);
    if (!afterLogout.ok) expect(afterLogout.error.code).toBe('refresh_invalid');
  });

  it('logout-all revokes every session of the account', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'la@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    const l = await t.login.execute({ emailRaw: 'la@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(s.ok && l.ok).toBe(true);
    if (!s.ok || !l.ok) return;
    const accId = asAccountId(s.value.account.id);
    await t.logoutAll.execute({ accountId: accId });
    expect(await t.sessions.findActive(asSessionId(s.value.session.sessionId))).toBeNull();
    expect(await t.sessions.findActive(asSessionId(l.value.session.sessionId))).toBeNull();
  });

  it('blocks login when the throttle is locked', async () => {
    const lockedThrottle: LoginThrottle = {
      async check() {
        return { locked: true, retryAfterMs: 60_000 };
      },
      async recordFailure() {},
      async recordSuccess() {},
    };
    const t = build(lockedThrottle);
    await t.signup.execute({ emailRaw: 'th@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    const r = await t.login.execute({ emailRaw: 'th@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('account_locked');
  });

  it('records a throttle failure on bad credentials', async () => {
    let failures = 0;
    const counting: LoginThrottle = {
      async check() {
        return { locked: false, retryAfterMs: 0 };
      },
      async recordFailure() {
        failures += 1;
      },
      async recordSuccess() {},
    };
    const t = build(counting);
    await t.signup.execute({ emailRaw: 'c@example.com', passwordRaw: 'longenoughpassword', ...CTX });
    await t.login.execute({ emailRaw: 'c@example.com', passwordRaw: 'wrong-password-x', ...CTX });
    // A failed login records on BOTH throttle dimensions: per-IP and per-account.
    expect(failures).toBe(2);
  });
});
