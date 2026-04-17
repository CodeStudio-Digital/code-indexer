import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { RefreshToken, type RefreshTokenRow } from '../../core/auth/domain/refresh-token.js';
import type { RefreshTokenRepo } from '../../core/auth/ports/refresh-token-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqliteRefreshTokenRepo implements RefreshTokenRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  insert(token: RefreshToken): void {
    this.db
      .prepare(
        `INSERT INTO oauth_refresh_tokens
          (token_hash, client_id, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        token.tokenHash,
        token.clientId,
        token.scopes.toJson(),
        token.expiresAt,
        new Date(token.createdAt).toISOString(),
      );
  }

  findByHash(hash: string): RefreshToken | null {
    const row = this.db
      .prepare<[string], RefreshTokenRow>('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?')
      .get(hash);
    return row ? RefreshToken.fromRow(row) : null;
  }

  markRotated(oldHash: string, successorHash: string, at: number): void {
    this.db
      .prepare(
        'UPDATE oauth_refresh_tokens SET rotated_to = ?, revoked_at = ? WHERE token_hash = ?',
      )
      .run(successorHash, new Date(at).toISOString(), oldHash);
  }

  revoke(hash: string, at: number): void {
    this.db
      .prepare(
        'UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .run(new Date(at).toISOString(), hash);
  }

  /**
   * Defends against refresh token theft (RFC 6819 §5.2.2.3): when a rotated
   * token is reused, revoke the whole chain descended from it.
   */
  revokeChain(hash: string, at: number): void {
    const atIso = new Date(at).toISOString();
    const visited = new Set<string>();
    const queue: string[] = [hash];

    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      this.db
        .prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?')
        .run(atIso, current);

      const row = this.db
        .prepare<[string], { rotated_to: string | null }>(
          'SELECT rotated_to FROM oauth_refresh_tokens WHERE token_hash = ?',
        )
        .get(current);
      if (row?.rotated_to) queue.push(row.rotated_to);
    }
  }

  close(): void {
    this.db.close();
  }
}
