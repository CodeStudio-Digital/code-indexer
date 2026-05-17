/**
 * Migration 036 — shared environment variables per company session.
 *
 * Why at the session level (not the project level)?
 *   - A company session now hosts N microservice projects (migration
 *     035). Users expect envs like DATABASE_URL / API_BASE_URL to be
 *     shared by every service in the stack — a single source of truth
 *     the frontend and backend both read.
 *   - Per-project envs would force the user to duplicate (and re-sync)
 *     common secrets across every microservice they add.
 *
 * Injection path: `SandboxManager.provision` reads this table on every
 * provision / resume and passes the resulting pairs to the driver as
 * container env vars. We also materialize `/app/.env` inside the
 * workdir so running apps (vite dev server, wrangler, node's native
 * `--env-file`) pick them up without a container restart.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companySessionEnvs036 = {
  version: 36,
  name: 'company_session_envs',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_session_envs (
        session_id  INTEGER NOT NULL
                    REFERENCES company_sessions(id) ON DELETE CASCADE,
        -- Keys are upper-case + underscores by convention, but we do NOT
        -- enforce it at the DB layer — operators sometimes have legit
        -- lowercase variables (e.g. 'npm_config_*'). Validation happens
        -- in the REST route.
        key         TEXT NOT NULL,
        value       TEXT NOT NULL DEFAULT '',
        -- When 1, the UI masks the value (shows ••••) and the REST
        -- endpoint omits it from list responses by default. The agent
        -- tools still expose the plaintext because agents need to
        -- write configuration code that references the real value.
        is_secret   INTEGER NOT NULL DEFAULT 0
                    CHECK(is_secret IN (0,1)),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, key)
      );

      CREATE INDEX idx_company_session_envs_session
        ON company_session_envs(session_id);
    `);
  },
};
