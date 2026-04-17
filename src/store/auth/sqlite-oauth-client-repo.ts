import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { OAuthClient, type OAuthClientRow } from '../../core/auth/domain/oauth-client.js';
import type {
  OAuthClientAdminRepo,
  OAuthClientReaderRepo,
} from '../../core/auth/ports/oauth-client-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqliteOAuthClientRepo implements OAuthClientReaderRepo, OAuthClientAdminRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  findById(clientId: string): OAuthClient | null {
    const row = this.db
      .prepare<[string], OAuthClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?')
      .get(clientId);
    return row ? OAuthClient.fromRow(row) : null;
  }

  insert(client: OAuthClient): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
           scopes, token_endpoint_auth_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.clientId,
        client.clientSecretHash,
        client.clientName,
        JSON.stringify(client.redirectUris),
        JSON.stringify(client.grantTypes),
        client.scopes.toJson(),
        client.tokenEndpointAuthMethod,
        new Date(client.createdAt).toISOString(),
      );
  }

  listAll(): OAuthClient[] {
    const rows = this.db
      .prepare<[], OAuthClientRow>('SELECT * FROM oauth_clients ORDER BY created_at DESC')
      .all();
    return rows.map((r) => OAuthClient.fromRow(r));
  }

  revoke(clientId: string, at: number): void {
    this.db
      .prepare('UPDATE oauth_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL')
      .run(new Date(at).toISOString(), clientId);
  }

  close(): void {
    this.db.close();
  }
}
