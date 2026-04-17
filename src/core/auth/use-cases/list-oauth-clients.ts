import type { OAuthClient } from '../domain/oauth-client.js';
import type { OAuthClientAdminRepo } from '../ports/oauth-client-repository.js';

export class ListOAuthClients {
  constructor(private readonly repo: OAuthClientAdminRepo) {}

  execute(): OAuthClient[] {
    return this.repo.listAll();
  }
}
