/**
 * Email verification — send a one-time link, then consume it to mark the
 * account verified. Tokens are opaque (only the SHA-256 hash is stored), TTL 24h.
 */
import { type Result, ok, err, type AccountId, type Clock, type IdGen } from '@cloudstudio/cloud-kernel';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { AccountRepo, EmailSender, MailComposer, OneTimeTokenRepo, OpaqueTokenFactory } from '../domain/ports.js';

const VERIFY_TTL_S = 24 * 60 * 60;

export class SendVerificationEmailUseCase {
  constructor(
    private readonly tokens: OneTimeTokenRepo,
    private readonly opaque: OpaqueTokenFactory,
    private readonly composer: MailComposer,
    private readonly sender: EmailSender,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}
  async execute(input: { accountId: AccountId; email: string }): Promise<Result<{ ok: true }, IdentityError>> {
    const { token, hash } = await this.opaque.issue();
    await this.tokens.create({
      id: this.ids.uuid(),
      accountId: input.accountId,
      purpose: 'verify_email',
      tokenHash: hash,
      expiresAtMs: this.clock.now() + VERIFY_TTL_S * 1000,
    });
    await this.sender.send(this.composer.verification(input.email, token));
    return ok({ ok: true });
  }
}

export class VerifyEmailUseCase {
  constructor(
    private readonly tokens: OneTimeTokenRepo,
    private readonly opaque: OpaqueTokenFactory,
    private readonly accounts: AccountRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { token: string }): Promise<Result<{ ok: true }, IdentityError>> {
    const hash = await this.opaque.hashOf(input.token);
    const row = await this.tokens.findValid(hash, 'verify_email');
    if (!row) return err(IdentityErrors.emailTokenInvalid());
    const now = this.clock.isoNow();
    // Consume FIRST (atomic claim) — only the winner of a concurrent race acts.
    if (!(await this.tokens.consume(row.id, now))) return err(IdentityErrors.emailTokenInvalid());
    await this.accounts.markEmailVerified(row.accountId, now);
    return ok({ ok: true });
  }
}
