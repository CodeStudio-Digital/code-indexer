import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import {
  McpOAuthRegistration,
  type McpOAuthRegistrationRow,
} from '../../core/mcp-client/auth/domain/oauth-registration.js';
import type {
  McpOAuthRegistrationAdminRepo,
  McpOAuthRegistrationReaderRepo,
} from '../../core/mcp-client/auth/ports/oauth-registration-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqliteMcpOAuthRegistrationRepo
  implements McpOAuthRegistrationReaderRepo, McpOAuthRegistrationAdminRepo
{
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  findByServerId(serverId: string): McpOAuthRegistration | null {
    const row = this.db
      .prepare<[string], McpOAuthRegistrationRow>(
        'SELECT * FROM mcp_oauth_registrations WHERE server_id = ?',
      )
      .get(serverId);
    return row ? McpOAuthRegistration.fromRow(row) : null;
  }

  upsert(r: McpOAuthRegistration): void {
    this.db
      .prepare(
        `INSERT INTO mcp_oauth_registrations
           (server_id, issuer, authorization_endpoint, token_endpoint,
            revocation_endpoint, registration_source, client_id,
            client_secret, client_secret_hash, scopes, redirect_uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           issuer = excluded.issuer,
           authorization_endpoint = excluded.authorization_endpoint,
           token_endpoint = excluded.token_endpoint,
           revocation_endpoint = excluded.revocation_endpoint,
           registration_source = excluded.registration_source,
           client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           client_secret_hash = excluded.client_secret_hash,
           scopes = excluded.scopes,
           redirect_uri = excluded.redirect_uri,
           created_at = excluded.created_at`,
      )
      .run(
        r.serverId,
        r.issuer,
        r.authorizationEndpoint,
        r.tokenEndpoint,
        r.revocationEndpoint,
        r.registrationSource,
        r.clientId,
        r.clientSecret,
        r.clientSecretHash,
        JSON.stringify(r.scopes),
        r.redirectUri,
        new Date(r.createdAt).toISOString(),
      );
  }

  delete(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_oauth_registrations WHERE server_id = ?').run(serverId);
  }

  listAll(): McpOAuthRegistration[] {
    const rows = this.db
      .prepare<[], McpOAuthRegistrationRow>(
        'SELECT * FROM mcp_oauth_registrations ORDER BY created_at DESC',
      )
      .all();
    return rows.map((r) => McpOAuthRegistration.fromRow(r));
  }

  close(): void {
    this.db.close();
  }
}
