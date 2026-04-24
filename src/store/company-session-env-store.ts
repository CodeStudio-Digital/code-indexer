/**
 * CompanySessionEnvStore — shared env vars for a company session.
 *
 * Used by:
 *   - REST routes (`GET/PUT/DELETE /api/company/sessions/:id/envs`) so
 *     users manage the list from the Env tab.
 *   - `SandboxManager` at provision/resume time to seed container env.
 *   - The `env_*` agent tools (read / list / set / delete) so agents
 *     can introspect and evolve shared config without leaving the sandbox.
 *
 * The store is a plain CRUD facade; all policy (what's a valid key,
 * whose turn it is to modify, audit trails) lives in the callers.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type CompanySessionEnvSource = 'user' | 'imported' | 'auto' | 'agent';

export interface CompanySessionEnvRow {
  session_id: number;
  key: string;
  value: string;
  is_secret: 0 | 1;
  source: CompanySessionEnvSource;
  created_at: string;
  updated_at: string;
}

export interface UpsertOptions {
  /** Provenance tag — see migration 039. Defaults to `'user'`. */
  source?: CompanySessionEnvSource;
  /**
   * Insert-only: when true, skip the write if a row already exists for
   * this (session, key). Used by the `.env` import path so a pre-
   * existing user value is never overwritten by the imported default.
   */
  onlyIfAbsent?: boolean;
}

export class CompanySessionEnvStore {
  constructor(private readonly db: DB) {}

  list(sessionId: number): CompanySessionEnvRow[] {
    return this.db
      .prepare(
        'SELECT * FROM company_session_envs WHERE session_id = ? ORDER BY key ASC',
      )
      .all(sessionId) as CompanySessionEnvRow[];
  }

  get(sessionId: number, key: string): CompanySessionEnvRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM company_session_envs WHERE session_id = ? AND key = ?')
        .get(sessionId, key) as CompanySessionEnvRow | undefined) ?? null
    );
  }

  /**
   * Write a key. Upsert — an existing entry's value/is_secret/source
   * fields are overwritten by default, created_at preserved. Pass
   * `onlyIfAbsent: true` to keep existing rows untouched (used by the
   * `.env` import path so imports don't clobber user edits).
   */
  upsert(
    sessionId: number,
    key: string,
    value: string,
    isSecret: boolean,
    opts: UpsertOptions = {},
  ): void {
    const source: CompanySessionEnvSource = opts.source ?? 'user';
    if (opts.onlyIfAbsent) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO company_session_envs (session_id, key, value, is_secret, source)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, key, value, isSecret ? 1 : 0, source);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO company_session_envs (session_id, key, value, is_secret, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET
           value = excluded.value,
           is_secret = excluded.is_secret,
           source = excluded.source,
           updated_at = datetime('now')`,
      )
      .run(sessionId, key, value, isSecret ? 1 : 0, source);
  }

  delete(sessionId: number, key: string): void {
    this.db
      .prepare('DELETE FROM company_session_envs WHERE session_id = ? AND key = ?')
      .run(sessionId, key);
  }

  /** Flat key→value map, convenient for container env injection. */
  asRecord(sessionId: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.list(sessionId)) {
      out[row.key] = row.value;
    }
    return out;
  }
}
