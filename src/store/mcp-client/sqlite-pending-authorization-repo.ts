import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import {
  PendingAuthorization,
  type PendingAuthorizationRow,
} from '../../core/mcp-client/auth/domain/pending-authorization.js';
import type { PendingAuthorizationRepo } from '../../core/mcp-client/auth/ports/pending-authorization-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqlitePendingAuthorizationRepo implements PendingAuthorizationRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  insert(p: PendingAuthorization): void {
    this.db
      .prepare(
        `INSERT INTO mcp_oauth_pending
           (state, server_id, verifier, redirect_uri, scopes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.state,
        p.serverId,
        p.verifier,
        p.redirectUri,
        JSON.stringify(p.scopes),
        p.expiresAt,
      );
  }

  consume(state: string, at: number): PendingAuthorization | null {
    const tx = this.db.transaction((s: string, t: number) => {
      const row = this.db
        .prepare<[string], PendingAuthorizationRow>(
          'SELECT * FROM mcp_oauth_pending WHERE state = ? AND consumed_at IS NULL',
        )
        .get(s);
      if (!row) return null;
      this.db
        .prepare('UPDATE mcp_oauth_pending SET consumed_at = ? WHERE state = ?')
        .run(new Date(t).toISOString(), s);
      return row;
    });
    const row = tx(state, at) as PendingAuthorizationRow | null;
    return row ? PendingAuthorization.fromRow(row) : null;
  }

  purgeExpired(before: number): void {
    this.db.prepare('DELETE FROM mcp_oauth_pending WHERE expires_at < ?').run(before);
  }

  close(): void {
    this.db.close();
  }
}
