/**
 * Challenge2faUseCase — completes a login that returned `twofa_required`. The
 * client presents the single-use challenge token + either a TOTP code OR a
 * one-time recovery code; on success a session is issued and the challenge token
 * is burned (no replay). A per-account throttle bounds brute force of the
 * 6-digit code; recovery codes are consumed atomically.
 */
import { type Result, ok, err } from '@cloudstudio/cloud-kernel';
import type { Account } from '../domain/account.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type {
  AccountRepo,
  ChallengeTokenPort,
  LoginThrottle,
  RecoveryCodeService,
  TotpPort,
  TwoFactorRepo,
} from '../domain/ports.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface ChallengeInput {
  challengeToken: string;
  code: string;
  userAgent: string | null;
  ipHash: string | null;
}
export interface ChallengeOutput {
  account: ReturnType<Account['toPublic']>;
  session: IssuedSession;
}

export class Challenge2faUseCase {
  constructor(
    private readonly challengeTokens: ChallengeTokenPort,
    private readonly twoFactor: TwoFactorRepo,
    private readonly totp: TotpPort,
    private readonly recovery: RecoveryCodeService,
    private readonly accounts: AccountRepo,
    private readonly issuer: SessionIssuer,
    private readonly throttle: LoginThrottle,
  ) {}

  async execute(input: ChallengeInput): Promise<Result<ChallengeOutput, IdentityError>> {
    const claim = await this.challengeTokens.verify(input.challengeToken); // peek, no consume yet
    if (!claim) return err(IdentityErrors.twofaInvalid());

    const key = `2fa:${claim.accountId}`;
    const gate = await this.throttle.check(key);
    if (gate.locked) return err(IdentityErrors.accountLocked(gate.retryAfterMs));

    const tf = await this.twoFactor.getSecret(claim.accountId);
    if (!tf || !tf.enabled) return err(IdentityErrors.twofaInvalid());

    let valid = await this.totp.verify(tf.secret, input.code);
    if (!valid) {
      const hash = await this.recovery.hashOf(input.code);
      valid = await this.twoFactor.consumeRecoveryCode(claim.accountId, hash);
    }
    if (!valid) {
      await this.throttle.recordFailure(key);
      return err(IdentityErrors.twofaInvalid());
    }

    // Single-use the challenge token (replay protection); lose the race ⇒ reject.
    if (!(await this.challengeTokens.consume(input.challengeToken))) return err(IdentityErrors.twofaInvalid());
    await this.throttle.recordSuccess(key);

    const account = await this.accounts.findById(claim.accountId);
    if (!account || !account.isActive) return err(IdentityErrors.twofaInvalid());

    const session = await this.issuer.issue({
      accountId: claim.accountId,
      emailVerified: account.isEmailVerified,
      userAgent: input.userAgent,
      ipHash: input.ipHash,
    });
    return ok({ account: account.toPublic(), session });
  }
}
