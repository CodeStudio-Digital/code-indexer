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
  private readonly hasProfileSchema: boolean;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const profileTable = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_connection_profiles'",
    ).get();
    const profileColumn = (this.db.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string }>)
      .some((column) => column.name === 'profile_id');
    this.hasProfileSchema = Boolean(profileTable) && profileColumn;
  }

  findByHash(tokenHash: string): ApiToken | null {
    const sql = this.hasProfileSchema
      ? `
        SELECT t.*,
          p.name AS profile_name,
          p.project_ids AS profile_project_ids,
          p.tool_allowlist AS profile_tool_allowlist,
          p.agent_allowlist AS profile_agent_allowlist,
          p.approval_mode AS profile_approval_mode,
          p.max_concurrent_runs AS profile_max_concurrent_runs,
          p.max_runtime_ms AS profile_max_runtime_ms
        FROM api_tokens t
        LEFT JOIN mcp_connection_profiles p ON p.id = t.profile_id
        WHERE t.token_hash = ?
      `
      : 'SELECT * FROM api_tokens WHERE token_hash = ?';
    const row = this.db
      .prepare<[string], ApiTokenRow>(sql)
      .get(tokenHash);
    return row ? ApiToken.fromRow(row) : null;
  }

  touchLastUsed(id: string, at: number): void {
    this.db
      .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
      .run(new Date(at).toISOString(), id);
  }

  insert(token: ApiToken): void {
    if (!this.hasProfileSchema) {
      this.db
        .prepare(
          `INSERT INTO api_tokens (id, token_hash, name, scopes, expires_at, created_at, tier)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          token.id,
          token.tokenHash,
          token.name,
          token.scopes.toJson(),
          token.expiresAt,
          new Date(token.createdAt).toISOString(),
          token.tier,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO api_tokens (id, token_hash, name, scopes, expires_at, created_at, tier, profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.tokenHash,
        token.name,
        token.scopes.toJson(),
        token.expiresAt,
        new Date(token.createdAt).toISOString(),
        token.tier,
        token.profileId,
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
