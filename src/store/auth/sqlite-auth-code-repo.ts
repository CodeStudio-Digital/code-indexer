import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import { AuthCode, type AuthCodeRow } from '../../core/auth/domain/auth-code.js';
import type { AuthCodeRepo } from '../../core/auth/ports/auth-code-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export class SqliteAuthCodeRepo implements AuthCodeRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  insert(code: AuthCode): void {
    this.db
      .prepare(
        `INSERT INTO oauth_auth_codes
          (code, client_id, redirect_uri, scopes, code_challenge,
           code_challenge_method, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code.code,
        code.clientId,
        code.redirectUri,
        code.scopes.toJson(),
        code.codeChallenge,
        code.codeChallengeMethod,
        code.expiresAt,
      );
  }

  /**
   * Atomic one-shot consume. Returns the row only if it was still unconsumed.
   */
  consume(code: string, at: number): AuthCode | null {
    const tx = this.db.transaction((c: string, t: number) => {
      const row = this.db
        .prepare<[string], AuthCodeRow>(
          'SELECT * FROM oauth_auth_codes WHERE code = ? AND consumed_at IS NULL',
        )
        .get(c);
      if (!row) return null;
      this.db
        .prepare('UPDATE oauth_auth_codes SET consumed_at = ? WHERE code = ?')
        .run(new Date(t).toISOString(), c);
      return row;
    });
    const row = tx(code, at) as AuthCodeRow | null;
    return row ? AuthCode.fromRow(row) : null;
  }

  purgeExpired(before: number): void {
    this.db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?').run(before);
  }

  close(): void {
    this.db.close();
  }
}
