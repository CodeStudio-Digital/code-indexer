/**
 * Logout use-cases. Revoking a session (and its refresh tokens) takes effect
 * immediately because protected routes re-check session validity per request
 * (the access token alone is not trusted past revocation). `LogoutAll` is the
 * "sign out everywhere" / account-compromise button.
 */
import { type Result, ok, type Clock, type AccountId, type SessionId } from '@cloudstudio/cloud-kernel';
import type { IdentityError } from '../domain/errors.js';
import type { RefreshTokenRepo, SessionRepo } from '../domain/ports.js';

export class LogoutUseCase {
  constructor(
    private readonly sessions: SessionRepo,
    private readonly refresh: RefreshTokenRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { accountId: AccountId; sessionId: SessionId }): Promise<Result<{ ok: true }, IdentityError>> {
    const now = this.clock.isoNow();
    await this.sessions.revoke(input.sessionId, now);
    await this.refresh.revokeBySession(input.sessionId, now);
    return ok({ ok: true });
  }
}

export class LogoutAllUseCase {
  constructor(
    private readonly sessions: SessionRepo,
    private readonly refresh: RefreshTokenRepo,
    private readonly clock: Clock,
  ) {}
  async execute(input: { accountId: AccountId }): Promise<Result<{ ok: true }, IdentityError>> {
    const now = this.clock.isoNow();
    await this.sessions.revokeAllForAccount(input.accountId, now);
    await this.refresh.revokeByAccount(input.accountId, now);
    return ok({ ok: true });
  }
}
