import type { ApiTokenAdminRepo } from '../ports/api-token-repository.js';
import type { Clock } from '../ports/clock.js';

export class RevokeApiToken {
  constructor(
    private readonly repo: ApiTokenAdminRepo,
    private readonly clock: Clock,
  ) {}

  execute(id: string): void {
    this.repo.revoke(id, this.clock.now());
  }
}
