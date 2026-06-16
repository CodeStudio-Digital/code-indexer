/**
 * RefreshUseCase — rotate the opaque refresh token (one-shot) and mint a fresh
 * access token. Reuse detection: presenting an ALREADY-CONSUMED token means the
 * token leaked, so the whole rotation family is revoked (forces re-login on all
 * descendants). Mirrors `packages/services/src/auth/use-cases/refresh-access-token.ts`.
 */
import { type Result, ok, err, type Clock } from '@cloudstudio/cloud-kernel';
import { IdentityErrors, type IdentityError } from '../domain/errors.js';
import type { AccountRepo, OpaqueTokenFactory, RefreshTokenRepo, SessionRepo } from '../domain/ports.js';
import { SessionIssuer, type IssuedSession } from './session-issuer.js';

export interface RefreshInput {
  refreshToken: string;
}
export interface RefreshOutput {
  session: IssuedSession;
}

export class RefreshUseCase {
  constructor(
    private readonly refreshTokens: RefreshTokenRepo,
    private readonly sessions: SessionRepo,
    private readonly accounts: AccountRepo,
    private readonly opaque: OpaqueTokenFactory,
    private readonly issuer: SessionIssuer,
    private readonly clock: Clock,
  ) {}

  async execute(input: RefreshInput): Promise<Result<RefreshOutput, IdentityError>> {
    const hash = await this.opaque.hashOf(input.refreshToken);
    const row = await this.refreshTokens.findByHash(hash);
    if (!row || row.revokedAt) return err(IdentityErrors.refreshInvalid());

    // Reuse: a consumed token presented again ⇒ family is compromised.
    if (row.consumedAt) {
      await this.refreshTokens.revokeFamily(row.familyId, this.clock.isoNow());
      return err(IdentityErrors.tokenReuse());
    }
    if (new Date(row.expiresAtIso).getTime() <= this.clock.now()) return err(IdentityErrors.refreshExpired());

    const session = await this.sessions.findActive(row.sessionId);
    if (!session) return err(IdentityErrors.refreshInvalid());
    const account = await this.accounts.findById(row.accountId);
    if (!account || !account.isActive) return err(IdentityErrors.refreshInvalid());

    // Atomically claim the token. If another concurrent request already rotated
    // it, `consume` returns false — that is a reuse race, so kill the family.
    const claimed = await this.refreshTokens.consume(row.id, this.clock.isoNow());
    if (!claimed) {
      await this.refreshTokens.revokeFamily(row.familyId, this.clock.isoNow());
      return err(IdentityErrors.tokenReuse());
    }
    const issued = await this.issuer.rotate({
      sessionId: row.sessionId,
      accountId: row.accountId,
      emailVerified: account.isEmailVerified,
      familyId: row.familyId,
      prevId: row.id,
    });
    return ok({ session: issued });
  }
}
