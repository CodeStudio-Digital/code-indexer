/**
 * LoginUseCase — verify credentials, then open a session. Hardened against:
 *  - enumeration + timing: every failure returns the SAME generic
 *    `invalid_credentials`, and absent/invalid/deleted paths run `dummyVerify`
 *    so timing doesn't reveal whether the account exists;
 *  - brute force: a per-key `LoginThrottle` (Durable Object) gate — locked keys
 *    short-circuit to `account_locked`; failures are recorded, success resets.
 * (TOTP 2FA branch — returning `twofa_required` — lands in the next increment.)
 */
import { type Result, ok, err } from '@cloudstudio/cloud-kernel';
import { Email } from '../domain/email.js';
import type { Account } from '../domain/account.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type {
  AccountRepo,
  ChallengeTokenPort,
  LoginThrottle,
  PasswordHasher,
  TwoFactorRepo,
} from '../domain/ports.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface LoginInput {
  emailRaw: string;
  passwordRaw: string;
  userAgent: string | null;
  ipHash: string | null;
}
export interface LoginOutput {
  account: ReturnType<Account['toPublic']>;
  session: IssuedSession;
}

export class LoginUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly hasher: PasswordHasher,
    private readonly issuer: SessionIssuer,
    private readonly throttle: LoginThrottle,
    private readonly twoFactor: TwoFactorRepo,
    private readonly challengeTokens: ChallengeTokenPort,
  ) {}

  async execute(input: LoginInput): Promise<Result<LoginOutput, IdentityError>> {
    const key = input.ipHash ?? 'unknown';
    const gate = await this.throttle.check(key);
    if (gate.locked) return err(IdentityErrors.accountLocked(gate.retryAfterMs));

    const fail = async (): Promise<Result<LoginOutput, IdentityError>> => {
      await this.throttle.recordFailure(key);
      return err(IdentityErrors.invalidCredentials());
    };

    const emailRes = Email.create(input.emailRaw);
    if (!emailRes.ok) {
      await this.hasher.dummyVerify(input.passwordRaw);
      return fail();
    }
    const cred = await this.accounts.findCredentialByCanonical(emailRes.value.canonical);
    if (!cred || cred.account.status === 'deleted') {
      await this.hasher.dummyVerify(input.passwordRaw);
      return fail();
    }
    const valid = await this.hasher.verify(input.passwordRaw, cred.passwordHash);
    if (!valid) return fail();
    if (cred.account.status === 'locked') return err(IdentityErrors.accountLocked(0));

    // Password is correct — reset the throttle, then branch on 2FA.
    await this.throttle.recordSuccess(key);
    // Transparently upgrade a stale/weaker hash on successful login (best-effort).
    if (this.hasher.needsRehash(cred.passwordHash)) {
      try {
        await this.accounts.updatePasswordHash(cred.account.id, await this.hasher.hash(input.passwordRaw));
      } catch {
        /* never block login on a rehash write */
      }
    }
    const tf = await this.twoFactor.getSecret(cred.account.id);
    if (tf?.enabled) {
      const challengeToken = await this.challengeTokens.issue(cred.account.id, 300);
      return err(IdentityErrors.twofaRequired(challengeToken));
    }

    const session = await this.issuer.issue({
      accountId: cred.account.id,
      emailVerified: cred.account.isEmailVerified,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
    });
    return ok({ account: cred.account.toPublic(), session });
  }
}
