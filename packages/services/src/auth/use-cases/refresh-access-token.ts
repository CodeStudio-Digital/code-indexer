import { RefreshToken } from '../domain/refresh-token.js';
import type { Clock } from '../ports/clock.js';
import type { RandomId } from '../ports/random-id.js';
import type { RefreshTokenRepo } from '../ports/refresh-token-repository.js';
import type { TokenHasher } from '../ports/token-hasher.js';
import type { TokenSigner } from '../ports/token-signer.js';
import { err, ok, type Result } from './result.js';

export interface RefreshInput {
  refreshToken: string;
  clientId: string;
}

export interface RefreshOutput {
  accessToken: string;
  refreshToken: string;   // rotated
  expiresInSec: number;
  scope: string;
}

export interface RefreshConfig {
  issuer: string;
  audience: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

/**
 * RefreshAccessToken — rotates the refresh token on every use (RFC 6819
 * §5.2.2.3). If a rotated-out token is re-presented, the whole chain is
 * revoked (theft defense).
 */
export class RefreshAccessToken {
  constructor(
    private readonly repo: RefreshTokenRepo,
    private readonly signer: TokenSigner,
    private readonly hasher: TokenHasher,
    private readonly random: RandomId,
    private readonly clock: Clock,
    private readonly config: RefreshConfig,
  ) {}

  execute(input: RefreshInput): Result<RefreshOutput> {
    const hash = this.hasher.hash(input.refreshToken);
    const existing = this.repo.findByHash(hash);
    const now = this.clock.now();

    if (!existing) return err({ kind: 'invalid_grant' });
    if (existing.clientId !== input.clientId) return err({ kind: 'invalid_grant' });

    if (!existing.isUsable(now)) {
      // If token was already rotated and is being reused, treat as theft.
      if (existing.rotatedTo !== null) this.repo.revokeChain(hash, now);
      return err({ kind: 'invalid_grant' });
    }

    const rawNew = this.random.token(32);
    const newHash = this.hasher.hash(rawNew);

    this.repo.insert(
      RefreshToken.issue({
        tokenHash: newHash,
        clientId: existing.clientId,
        scopes: existing.scopes,
        expiresAt: now + this.config.refreshTtlSec * 1000,
        now,
      }),
    );
    this.repo.markRotated(hash, newHash, now);

    const nowSec = Math.floor(now / 1000);
    const accessToken = this.signer.sign({
      iss: this.config.issuer,
      sub: existing.clientId,
      aud: this.config.audience,
      exp: nowSec + this.config.accessTtlSec,
      iat: nowSec,
      scope: existing.scopes.values().join(' '),
      jti: this.random.uuid(),
    });

    return ok({
      accessToken,
      refreshToken: rawNew,
      expiresInSec: this.config.accessTtlSec,
      scope: existing.scopes.values().join(' '),
    });
  }
}
