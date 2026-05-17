import type { OAuthClientAdminRepo } from '../ports/oauth-client-repository.js';
import type { Clock } from '../ports/clock.js';

export class RevokeOAuthClient {
  constructor(
    private readonly repo: OAuthClientAdminRepo,
    private readonly clock: Clock,
  ) {}

  execute(clientId: string): void {
    this.repo.revoke(clientId, this.clock.now());
  }
}
