/**
 * Password reset. Request is anti-enumeration (ALWAYS returns ok, sends a mail
 * only if the account exists). Reset consumes the one-time token, sets the new
 * password, and revokes ALL sessions + refresh tokens (forces re-login).
 */
import { type Result, ok, err, type Clock, type IdGen } from '@cloudstudio/cloud-kernel';
import { Email } from '../domain/email.js';
import { Password } from '../domain/password.js';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type {
  AccountRepo,
  EmailSender,
  MailComposer,
  OneTimeTokenRepo,
  OpaqueTokenFactory,
  PasswordHasher,
  RefreshTokenRepo,
  SessionRepo,
} from '../domain/ports.js';

const RESET_TTL_S = 60 * 60;

export class RequestPasswordResetUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly tokens: OneTimeTokenRepo,
    private readonly opaque: OpaqueTokenFactory,
    private readonly composer: MailComposer,
    private readonly sender: EmailSender,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}
  async execute(input: { emailRaw: string }): Promise<Result<{ ok: true }, IdentityError>> {
    const emailRes = Email.create(input.emailRaw);
    if (!emailRes.ok) return ok({ ok: true }); // never reveal validity
    const account = await this.accounts.findByCanonical(emailRes.value.canonical);
    if (!account || account.status === 'deleted') return ok({ ok: true });
    const { token, hash } = await this.opaque.issue();
    await this.tokens.create({
      id: this.ids.uuid(),
      accountId: account.id,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAtMs: this.clock.now() + RESET_TTL_S * 1000,
    });
    await this.sender.send(this.composer.passwordReset(emailRes.value.value, token));
    return ok({ ok: true });
  }
}

export class ResetPasswordUseCase {
  constructor(
    private readonly accounts: AccountRepo,
    private readonly tokens: OneTimeTokenRepo,
    private readonly opaque: OpaqueTokenFactory,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionRepo,
    private readonly refresh: RefreshTokenRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { token: string; newPasswordRaw: string }): Promise<Result<{ ok: true }, IdentityError>> {
    const passwordRes = Password.create(input.newPasswordRaw);
    if (!passwordRes.ok) return passwordRes;
    const hash = await this.opaque.hashOf(input.token);
    const row = await this.tokens.findValid(hash, 'password_reset');
    if (!row) return err(IdentityErrors.emailTokenInvalid());
    const now = this.clock.isoNow();
    // Consume FIRST (atomic claim) — gates the password write on winning the race.
    if (!(await this.tokens.consume(row.id, now))) return err(IdentityErrors.emailTokenInvalid());

    const phc = await this.hasher.hash(passwordRes.value.plain);
    await this.accounts.updatePasswordHash(row.accountId, phc);
    await this.tokens.consumeAllForAccount(row.accountId, 'password_reset', now);
    // A reset invalidates every existing session everywhere.
    await this.sessions.revokeAllForAccount(row.accountId, now);
    await this.refresh.revokeByAccount(row.accountId, now);
    return ok({ ok: true });
  }
}
