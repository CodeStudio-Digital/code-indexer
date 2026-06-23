import type { Clock } from '../ports/clock.js';
import type { RefreshTokenRepo } from '../ports/refresh-token-repository.js';
import type { TokenHasher } from '../ports/token-hasher.js';

/**
 * RFC 7009 revocation. The endpoint accepts either access or refresh
 * tokens; only refresh tokens have server-side state, so that's what we
 * revoke. Access token JWTs are self-contained and just expire.
 */
export class RevokeOAuthToken {
  constructor(
    private readonly repo: RefreshTokenRepo,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  execute(token: string): void {
    const hash = this.hasher.hash(token);
    this.repo.revoke(hash, this.clock.now());
  }
}
