import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { ApiToken, type ApiTokenRow } from '@mcp/services/auth/domain/api-token.js';
import type {
  ApiTokenAdminRepo,
  ApiTokenReaderRepo,
} from '@mcp/services/auth/ports/api-token-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

/**
 * Single SQLite adapter implementing both the reader and admin interfaces.
 * Callers request only the interface they need (ISP), so compile-time
 * privileges are enforced even though the runtime object is the same.
 */
export class SqliteApiTokenRepo implements ApiTokenReaderRepo, ApiTokenAdminRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  findByHash(tokenHash: string): ApiToken | null {
    const row = this.db
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?')
      .get(tokenHash);
    return row ? ApiToken.fromRow(row) : null;
  }

  touchLastUsed(id: string, at: number): void {
    this.db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date(at).toISOString(), id);
  }

  insert(token: ApiToken): void {
    this.db
      .prepare(
        `INSERT INTO api_tokens (id, token_hash, name, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.tokenHash,
        token.name,
        token.scopes.toJson(),
        token.expiresAt,
        new Date(token.createdAt).toISOString(),
      );
  }

  listAll(): ApiToken[] {
    const rows = this.db
      .prepare<[], ApiTokenRow>('SELECT * FROM api_tokens ORDER BY created_at DESC')
      .all();
    return rows.map((r) => ApiToken.fromRow(r));
  }

  findById(id: string): ApiToken | null {
    const row = this.db
      .prepare<[string], ApiTokenRow>('SELECT * FROM api_tokens WHERE id = ?')
      .get(id);
    return row ? ApiToken.fromRow(row) : null;
  }

  revoke(id: string, at: number): void {
    this.db
      .prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date(at).toISOString(), id);
  }

  close(): void {
    this.db.close();
  }
}
