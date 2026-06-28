/**
 * Authenticated password change. Unlike reset (which is token-gated, out-of-band),
 * this reauths with the CURRENT password, then sets the new one and revokes ALL
 * sessions + refresh tokens — same blast radius as a reset, so a changed password
 * logs the user out everywhere (the initiating client re-authenticates). Mirrors
 * ResetPasswordUseCase's write+revoke; the only difference is the gate (password
 * reauth vs one-time token).
 */
import { type Result, ok, err, type Clock, type AccountId } from '@cloudstudio/cloud-kernel';
import { Password } from '../domain/password.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { AccountRepo, PasswordHasher, RefreshTokenRepo, SessionRepo } from '../domain/ports.js';

export class ChangePasswordUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionRepo,
    private readonly refresh: RefreshTokenRepo,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    accountId: AccountId;
    currentPassword: string;
    newPasswordRaw: string;
  }): Promise<Result<{ ok: true }, IdentityError>> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) return err(IdentityErrors.invalidCredentials());
    // Reauth against the live hash. OAuth-only accounts carry a sentinel hash that
    // no password verifies, so this fails by design (password change is a
    // password-account feature; OAuth users manage sign-in at their provider).
    const cred = await this.accounts.findCredentialByCanonical(account.emailCanonical);
    if (!cred || !(await this.hasher.verify(input.currentPassword, cred.passwordHash))) {
      return err(IdentityErrors.invalidCredentials());
    }
    const passwordRes = Password.create(input.newPasswordRaw);
    if (!passwordRes.ok) return passwordRes; // password_too_weak
    await this.accounts.updatePasswordHash(input.accountId, await this.hasher.hash(passwordRes.value.plain));
    // A password change invalidates every existing session everywhere (parity with reset).
    const now = this.clock.isoNow();
    await this.sessions.revokeAllForAccount(input.accountId, now);
    await this.refresh.revokeByAccount(input.accountId, now);
    return ok({ ok: true });
  }
}
