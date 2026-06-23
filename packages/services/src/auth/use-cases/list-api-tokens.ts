import type { ApiToken } from '../domain/api-token.js';
import type { ApiTokenAdminRepo } from '../ports/api-token-repository.js';

export class ListApiTokens {
  constructor(private readonly repo: ApiTokenAdminRepo) {}

  execute(): ApiToken[] {
    return this.repo.listAll();
  }
}
