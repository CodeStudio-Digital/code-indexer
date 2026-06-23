/**
 * CompanySessionDatabaseStore — typed databases registered per session.
 *
 * Only stores **metadata** (label, provider, which env keys hold the
 * values). The actual connection strings / API keys live in
 * `company_session_envs` so container injection and the dashboard Env
 * tab keep working unchanged.
 *
 * Used by the REST routes in `routes/company/databases.ts` and by the
 * `db_*` agent tools, both via setter-based injection.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type {
  CompanySessionDatabase,
  CompanySessionDatabaseRow,
  DatabaseProvider,
  EnvKeyMap,
} from '@mcp/company/database-types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface InsertDatabaseInput {
  session_id: number;
  label: string;
  provider: DatabaseProvider;
  is_primary: boolean;
  env_keys: EnvKeyMap;
  metadata?: Record<string, string>;
}

export interface UpdateDatabaseInput {
  label?: string;
  is_primary?: boolean;
  env_keys?: EnvKeyMap;
  metadata?: Record<string, string>;
}

export class CompanySessionDatabaseStore {
  constructor(private readonly db: DB) {}

  list(sessionId: number): CompanySessionDatabase[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM company_session_databases
         WHERE session_id = ?
         ORDER BY is_primary DESC, label ASC`,
      )
      .all(sessionId) as CompanySessionDatabaseRow[];
    return rows.map(hydrate);
  }

  get(id: number): CompanySessionDatabase | null {
    const row = this.db
      .prepare('SELECT * FROM company_session_databases WHERE id = ?')
      .get(id) as CompanySessionDatabaseRow | undefined;
    return row ? hydrate(row) : null;
  }

  getByLabel(sessionId: number, label: string): CompanySessionDatabase | null {
    const row = this.db
      .prepare(
        'SELECT * FROM company_session_databases WHERE session_id = ? AND label = ?',
      )
      .get(sessionId, label) as CompanySessionDatabaseRow | undefined;
    return row ? hydrate(row) : null;
  }

  findPrimary(
    sessionId: number,
    provider: DatabaseProvider,
  ): CompanySessionDatabase | null {
    const row = this.db
      .prepare(
        `SELECT * FROM company_session_databases
         WHERE session_id = ? AND provider = ? AND is_primary = 1`,
      )
      .get(sessionId, provider) as CompanySessionDatabaseRow | undefined;
    return row ? hydrate(row) : null;
  }

  insert(input: InsertDatabaseInput): CompanySessionDatabase {
    const info = this.db
      .prepare(
        `INSERT INTO company_session_databases
           (session_id, label, provider, is_primary, env_keys_json, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id,
        input.label,
        input.provider,
        input.is_primary ? 1 : 0,
        JSON.stringify(input.env_keys),
        JSON.stringify(input.metadata ?? {}),
      );
    const id = Number(info.lastInsertRowid);
    const created = this.get(id);
    if (!created) throw new Error('insert: failed to reload row');
    return created;
  }

  update(id: number, patch: UpdateDatabaseInput): CompanySessionDatabase {
    const current = this.get(id);
    if (!current) throw new Error(`database ${id} not found`);
    const nextLabel = patch.label ?? current.label;
    const nextIsPrimary =
      patch.is_primary !== undefined ? patch.is_primary : current.is_primary;
    const nextEnvKeys = patch.env_keys ?? current.env_keys;
    const nextMetadata = patch.metadata ?? current.metadata;
    this.db
      .prepare(
        `UPDATE company_session_databases SET
           label = ?, is_primary = ?, env_keys_json = ?, metadata_json = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        nextLabel,
        nextIsPrimary ? 1 : 0,
        JSON.stringify(nextEnvKeys),
        JSON.stringify(nextMetadata),
        id,
      );
    const updated = this.get(id);
    if (!updated) throw new Error('update: row vanished mid-update');
    return updated;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM company_session_databases WHERE id = ?').run(id);
  }

  /**
   * Wraps `fn` in a single better-sqlite3 transaction. Used by the
   * HTTP routes to atomically write the DB row + upsert/delete
   * corresponding env vars without leaving the env table inconsistent
   * with the database row on error.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function hydrate(row: CompanySessionDatabaseRow): CompanySessionDatabase {
  return {
    id: row.id,
    session_id: row.session_id,
    label: row.label,
    provider: row.provider,
    is_primary: row.is_primary === 1,
    env_keys: parseJsonObject(row.env_keys_json) as EnvKeyMap,
    metadata: parseJsonObject(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonObject(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through
  }
  return {};
}
