import type { OAuthClient } from '../domain/oauth-client.js';

export interface OAuthClientReaderRepo {
  findById(clientId: string): OAuthClient | null;
}

export interface OAuthClientAdminRepo {
  insert(client: OAuthClient): void;
  listAll(): OAuthClient[];
  revoke(clientId: string, at: number): void;
}
