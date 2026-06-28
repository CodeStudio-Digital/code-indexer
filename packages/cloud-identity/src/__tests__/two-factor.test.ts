/**
 * TOTP 2FA loop tests with fake ports: enroll → confirm (recovery codes) →
 * login returns `twofa_required` → challenge with a TOTP code OR a one-time
 * recovery code (consumed) → session; plus disable and wrong-code rejection.
 */
import { describe, it, expect } from 'vitest';
import type { Clock, IdGen, AccountId, SessionId } from '@cloudstudio/cloud-kernel';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import {
  Account,
  SessionIssuer,
  SignupUseCase,
  LoginUseCase,
  Enroll2faUseCase,
  Confirm2faUseCase,
  Disable2faUseCase,
  Challenge2faUseCase,
  type AccessTokenSigner,
  type AccountRepo,
  type ChallengeTokenPort,
  type LoginThrottle,
  type NewAccount,
  type NewRefreshToken,
  type NewSession,
  type OpaqueTokenFactory,
  type PasswordHasher,
  type RecoveryCodeService,
  type RefreshTokenRepo,
  type SessionRepo,
  type StoredRefreshToken,
  type TotpPort,
  type TwoFactorRepo,
} from '@cloudstudio/cloud-identity';

let seq = 0;
const idGen: IdGen = { uuid: () => `id_${++seq}`, slug: () => `slug_${++seq}` };
const clock: Clock = { now: () => 1_700_000_000_000, isoNow: () => '2026-01-01T00:00:00.000Z' };
const hasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  verify: async (p, phc) => phc === `hashed:${p}`,
  needsRehash: () => false,
  dummyVerify: async () => {},
};
const signer: AccessTokenSigner = {
  sign: async (i) => `tok.${i.sub}`,
  verify: async () => null,
};
const opaque: OpaqueTokenFactory = {
  issue: async () => {
    const token = `rt_${++seq}`;
    return { token, hash: `h:${token}` };
  },
  hashOf: async (t) => `h:${t}`,
};
const noopThrottle: LoginThrottle = {
  async check() {
    return { locked: false, retryAfterMs: 0 };
  },
  async recordFailure() {},
  async recordSuccess() {},
};

// A fixed-code TOTP fake: '123456' is "the current code".
const fakeTotp: TotpPort = {
  generateSecret: () => 'JBSWY3DPEHPK3PXP',
  keyUri: (s, label) => `otpauth://totp/CodeStudio:${label}?secret=${s}`,
  verify: async (_secret, code) => (code === '123456' ? 1000 : null), // matched step 1000
};
const fakeRecovery: RecoveryCodeService = {
  async generate(n) {
    const out: { code: string; hash: string }[] = [];
    for (let i = 0; i < n; i++) {
      const code = `code-${i}`;
      out.push({ code, hash: `h:${code.toUpperCase()}` });
    }
    return out;
  },
  hashOf: async (code) => `h:${code.trim().toUpperCase()}`,
};
// Stateful single-use challenge tokens (issue→verify→consume), token shape `ct:<accountId>:<n>`.
const challengeStore = new Set<string>();
const fakeChallengeTokens: ChallengeTokenPort = {
  async issue(accountId) {
    const t = `ct:${accountId}:${++seq}`;
    challengeStore.add(t);
    return t;
  },
  async verify(token) {
    return challengeStore.has(token) ? { accountId: asAccountId(token.split(':')[1]) } : null;
  },
  async consume(token) {
    return challengeStore.delete(token);
  },
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
    this.byCanon.set(a.emailCanonical, {
      a: new Account(a.id, a.email, a.emailCanonical, 'active', null, clock.isoNow(), clock.isoNow()),
      hash: a.passwordHash,
    });
  }
  async insertOAuth() {}
  async updatePasswordHash() {}
  async markEmailVerified() {}
}
class FakeSessionRepo implements SessionRepo {
  private rows = new Map<string, { accountId: AccountId; revoked: boolean }>();
  async insert(s: NewSession) {
    this.rows.set(s.id, { accountId: s.accountId, revoked: false });
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
  async setDeviceInfo() {}
  async listByAccount() {
    return [];
  }
  async revokeAllForAccount() {}
}
class FakeRefreshRepo implements RefreshTokenRepo {
  private rows = new Map<string, StoredRefreshToken & { tokenHash: string }>();
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
  async consume() {
    return true;
  }
  async revokeFamily() {}
  async revokeBySession() {}
  async revokeByAccount() {}
}
class FakeTwoFactorRepo implements TwoFactorRepo {
  secrets = new Map<string, { secret: string; enabled: boolean; lastStep: number | null }>();
  codes = new Map<string, Set<string>>();
  async getSecret(id: AccountId) {
    return this.secrets.get(id) ?? null;
  }
  async upsertPending(id: AccountId, secret: string) {
    this.secrets.set(id, { secret, enabled: false, lastStep: null });
  }
  async enable(id: AccountId) {
    const s = this.secrets.get(id);
    if (s) s.enabled = true;
  }
  async markStep(id: AccountId, step: number) {
    const s = this.secrets.get(id);
    if (s) s.lastStep = step;
  }
  async disable(id: AccountId) {
    this.secrets.delete(id);
    this.codes.delete(id);
  }
  async addRecoveryCodes(id: AccountId, hashes: string[]) {
    this.codes.set(id, new Set(hashes));
  }
  async consumeRecoveryCode(id: AccountId, hash: string) {
    const set = this.codes.get(id);
    if (set?.has(hash)) {
      set.delete(hash);
      return true;
    }
    return false;
  }
}

function build() {
  const accounts = new FakeAccountRepo();
  const sessions = new FakeSessionRepo();
  const refresh = new FakeRefreshRepo();
  const twoFactor = new FakeTwoFactorRepo();
  const issuer = new SessionIssuer(sessions, refresh, signer, opaque, idGen, clock);
  return {
    twoFactor,
    signup: new SignupUseCase(accounts, hasher, issuer, idGen, clock),
    login: new LoginUseCase(accounts, hasher, issuer, noopThrottle, twoFactor, fakeChallengeTokens),
    enroll2fa: new Enroll2faUseCase(fakeTotp, twoFactor),
    confirm2fa: new Confirm2faUseCase(fakeTotp, twoFactor, fakeRecovery, noopThrottle),
    disable2fa: new Disable2faUseCase(fakeTotp, twoFactor, accounts, hasher, noopThrottle),
    challenge2fa: new Challenge2faUseCase(
      fakeChallengeTokens,
      twoFactor,
      fakeTotp,
      fakeRecovery,
      accounts,
      issuer,
      noopThrottle,
    ),
  };
}
const CTX = { userAgent: 'test', ipHash: null };
const challengeTokenOf = (loginErr: { details?: Record<string, unknown> }) =>
  String((loginErr.details ?? {}).challengeToken ?? '');

async function enrolled(t: ReturnType<typeof build>, email: string) {
  const s = await t.signup.execute({ emailRaw: email, passwordRaw: 'longenoughpassword', ...CTX });
  const accId = asAccountId(s.ok ? s.value.account.id : '');
  await t.enroll2fa.execute({ accountId: accId, accountLabel: email });
  const conf = await t.confirm2fa.execute({ accountId: accId, code: '123456' });
  return { accId, recoveryCodes: conf.ok ? conf.value.recoveryCodes : [] };
}

describe('TOTP 2FA', () => {
  it('enroll → confirm → login requires 2FA → challenge with TOTP issues a session', async () => {
    const t = build();
    const { recoveryCodes } = await enrolled(t, 'a@e.com');
    expect(recoveryCodes.length).toBe(10);

    const login = await t.login.execute({ emailRaw: 'a@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(login.ok).toBe(false);
    if (login.ok) return;
    expect(login.error.code).toBe('twofa_required');

    const ch = await t.challenge2fa.execute({ challengeToken: challengeTokenOf(login.error), code: '123456', ...CTX });
    expect(ch.ok).toBe(true);
  });

  it('rejects a REPLAYED TOTP code at the same step (single-use)', async () => {
    const t = build();
    await enrolled(t, 'rp@e.com');
    const l1 = await t.login.execute({ emailRaw: 'rp@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    if (l1.ok) return;
    const ch1 = await t.challenge2fa.execute({ challengeToken: challengeTokenOf(l1.error), code: '123456', ...CTX });
    expect(ch1.ok).toBe(true); // step 1000 consumed

    const l2 = await t.login.execute({ emailRaw: 'rp@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    if (l2.ok) return;
    const replay = await t.challenge2fa.execute({ challengeToken: challengeTokenOf(l2.error), code: '123456', ...CTX });
    expect(replay.ok).toBe(false); // same step 1000 → rejected
    if (!replay.ok) expect(replay.error.code).toBe('twofa_invalid');
  });

  it('challenge accepts a one-time recovery code and consumes it', async () => {
    const t = build();
    const { recoveryCodes } = await enrolled(t, 'b@e.com');
    const code = recoveryCodes[0];

    const login1 = await t.login.execute({ emailRaw: 'b@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(login1.ok).toBe(false);
    if (login1.ok) return;
    const ch1 = await t.challenge2fa.execute({ challengeToken: challengeTokenOf(login1.error), code, ...CTX });
    expect(ch1.ok).toBe(true);

    const login2 = await t.login.execute({ emailRaw: 'b@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    if (login2.ok) return;
    const reuse = await t.challenge2fa.execute({ challengeToken: challengeTokenOf(login2.error), code, ...CTX });
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.error.code).toBe('twofa_invalid');
  });

  it('confirm rejects a wrong TOTP code', async () => {
    const t = build();
    const s = await t.signup.execute({ emailRaw: 'd@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    const accId = asAccountId(s.ok ? s.value.account.id : '');
    await t.enroll2fa.execute({ accountId: accId, accountLabel: 'd@e.com' });
    const conf = await t.confirm2fa.execute({ accountId: accId, code: '000000' });
    expect(conf.ok).toBe(false);
    if (!conf.ok) expect(conf.error.code).toBe('twofa_invalid');
  });

  it('disable removes 2FA so login issues a session directly', async () => {
    const t = build();
    const { accId } = await enrolled(t, 'c@e.com');
    const dis = await t.disable2fa.execute({ accountId: accId, password: 'longenoughpassword', code: '123456' });
    expect(dis.ok).toBe(true);
    const login = await t.login.execute({ emailRaw: 'c@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(login.ok).toBe(true);
  });

  it('disable REQUIRES the correct password (step-up), not just a TOTP code', async () => {
    const t = build();
    const { accId } = await enrolled(t, 'd@e.com');
    const bad = await t.disable2fa.execute({ accountId: accId, password: 'wrong-password', code: '123456' });
    expect(bad.ok).toBe(false); // password step-up failed → 2FA stays on
    const login = await t.login.execute({ emailRaw: 'd@e.com', passwordRaw: 'longenoughpassword', ...CTX });
    expect(login.ok).toBe(false); // still twofa_required
  });
});
