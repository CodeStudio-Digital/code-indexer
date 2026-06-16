/**
 * TOTP 2FA use-cases (enroll → confirm → disable). Enroll stores a PENDING
 * secret + returns the otpauth URI (the client renders the QR); confirm verifies
 * a code, enables 2FA, and issues one-time recovery codes (shown ONCE). Disable
 * requires a current code. The login challenge lives in `challenge-2fa.ts`.
 */
import { type Result, ok, err, type AccountId } from '@cloudstudio/cloud-kernel';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { LoginThrottle, RecoveryCodeService, TotpPort, TwoFactorRepo } from '../domain/ports.js';

export interface EnrollOutput {
  otpauthUri: string;
  secret: string;
}
export class Enroll2faUseCase {
  constructor(
    private readonly totp: TotpPort,
    private readonly twoFactor: TwoFactorRepo,
  ) {}
  async execute(input: { accountId: AccountId; accountLabel: string }): Promise<Result<EnrollOutput, IdentityError>> {
    // Re-enrolling while ENABLED would silently downgrade 2FA to a new (possibly
    // attacker-chosen) secret — require an explicit disable first.
    const existing = await this.twoFactor.getSecret(input.accountId);
    if (existing?.enabled) return err(IdentityErrors.twofaInvalid());
    const secret = this.totp.generateSecret();
    await this.twoFactor.upsertPending(input.accountId, secret);
    return ok({ otpauthUri: this.totp.keyUri(secret, input.accountLabel), secret });
  }
}

export interface ConfirmOutput {
  recoveryCodes: string[];
}
export class Confirm2faUseCase {
  constructor(
    private readonly totp: TotpPort,
    private readonly twoFactor: TwoFactorRepo,
    private readonly recovery: RecoveryCodeService,
    private readonly throttle: LoginThrottle,
  ) {}
  async execute(input: { accountId: AccountId; code: string }): Promise<Result<ConfirmOutput, IdentityError>> {
    const key = `2fa:${input.accountId}`;
    const gate = await this.throttle.check(key);
    if (gate.locked) return err(IdentityErrors.accountLocked(gate.retryAfterMs));
    const tf = await this.twoFactor.getSecret(input.accountId);
    if (!tf) return err(IdentityErrors.twofaInvalid());
    if (!(await this.totp.verify(tf.secret, input.code))) {
      await this.throttle.recordFailure(key);
      return err(IdentityErrors.twofaInvalid());
    }
    await this.throttle.recordSuccess(key);
    await this.twoFactor.enable(input.accountId);
    const codes = await this.recovery.generate(10);
    await this.twoFactor.addRecoveryCodes(
      input.accountId,
      codes.map((c) => c.hash),
    );
    return ok({ recoveryCodes: codes.map((c) => c.code) });
  }
}

export class Disable2faUseCase {
  constructor(
    private readonly totp: TotpPort,
    private readonly twoFactor: TwoFactorRepo,
  ) {}
  async execute(input: { accountId: AccountId; code: string }): Promise<Result<{ ok: true }, IdentityError>> {
    const tf = await this.twoFactor.getSecret(input.accountId);
    if (!tf || !tf.enabled) return ok({ ok: true }); // already off — idempotent
    if (!(await this.totp.verify(tf.secret, input.code))) return err(IdentityErrors.twofaInvalid());
    await this.twoFactor.disable(input.accountId);
    return ok({ ok: true });
  }
}
