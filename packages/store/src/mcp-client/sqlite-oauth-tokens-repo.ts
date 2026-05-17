import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import {
  McpOAuthTokens,
  type McpOAuthTokensRow,
} from '@mcp/services/mcp-client/auth/domain/oauth-tokens.js';
import type {
  McpOAuthTokensAdminRepo,
  McpOAuthTokensReaderRepo,
} from '@mcp/services/mcp-client/auth/ports/oauth-tokens-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqliteMcpOAuthTokensRepo
  implements McpOAuthTokensReaderRepo, McpOAuthTokensAdminRepo
{
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  findByServerId(serverId: string): McpOAuthTokens | null {
    const row = this.db
      .prepare<[string], McpOAuthTokensRow>(
        'SELECT * FROM mcp_oauth_tokens WHERE server_id = ?',
      )
      .get(serverId);
    return row ? McpOAuthTokens.fromRow(row) : null;
  }

  upsert(t: McpOAuthTokens): void {
    this.db
      .prepare(
        `INSERT INTO mcp_oauth_tokens
           (server_id, access_token, access_expires_at, refresh_raw, refresh_hash,
            scopes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at,
           refresh_raw = excluded.refresh_raw,
           refresh_hash = excluded.refresh_hash,
           scopes = excluded.scopes,
           updated_at = excluded.updated_at`,
      )
      .run(
        t.serverId,
        t.accessToken,
        t.accessExpiresAt,
        t.refreshRaw,
        t.refreshHash,
        JSON.stringify(t.scopes),
        new Date(t.updatedAt).toISOString(),
      );
  }

  delete(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_oauth_tokens WHERE server_id = ?').run(serverId);
  }

  close(): void {
    this.db.close();
  }
}
