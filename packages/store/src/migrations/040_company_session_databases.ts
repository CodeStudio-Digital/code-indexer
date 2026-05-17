/**
 * Migration 040 — databases registered per company session.
 *
 * Complements `company_session_envs` (migration 036): each row is a
 * typed pointer from a user-friendly label (e.g. "main", "analytics")
 * to the set of env keys that hold its connection string / API keys.
 * The actual secret values stay in `company_session_envs`, which is
 * already injected into every container at provision time — so agents
 * read config via env_read() and the pipeline needs no changes.
 *
 * Layout:
 *   - `label` is unique per session so `db_query({label})` resolves
 *     deterministically.
 *   - `is_primary` (at most 1 per provider via partial index) marks the
 *     DB whose fields use unprefixed env names (DATABASE_URL,
 *     SUPABASE_URL). Additional DBs of the same provider get
 *     `<BASE>_<LABEL_UPPER>` envs. This keeps the common "one DB"
 *     case ergonomic and unambiguous when there are many.
 *   - `env_keys_json` records the actual env key chosen per field,
 *     so custom names (e.g. READ_REPLICA_URL) survive UI edits.
 *   - `metadata_json` stores provider-specific free-form data (Neon
 *     branch, Supabase project_ref) without needing columns per
 *     provider.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companySessionDatabases040 = {
  version: 40,
  name: 'company_session_databases',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_session_databases (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER NOT NULL
                        REFERENCES company_sessions(id) ON DELETE CASCADE,
        label           TEXT NOT NULL,
        provider        TEXT NOT NULL
                        CHECK(provider IN ('postgres','mysql','supabase','neon')),
        is_primary      INTEGER NOT NULL DEFAULT 0
                        CHECK(is_primary IN (0,1)),
        env_keys_json   TEXT NOT NULL,
        metadata_json   TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_session_db_label
        ON company_session_databases(session_id, label);

      -- At most one primary per (session, provider). Partial index so
      -- non-primary rows don't collide. Guarantees that unprefixed env
      -- names like DATABASE_URL map to exactly one DB.
      CREATE UNIQUE INDEX idx_session_db_primary
        ON company_session_databases(session_id, provider)
        WHERE is_primary = 1;

      CREATE INDEX idx_session_db_session
        ON company_session_databases(session_id);
    `);
  },
};
