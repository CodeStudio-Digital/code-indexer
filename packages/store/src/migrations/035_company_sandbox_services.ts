/**
 * Migration 035 — Multi-service sandboxes.
 *
 * Before: `company_sandboxes` (migration 034) held a 1:1 row per session.
 * A session could only have a single container running a single stack.
 *
 * After: each session can host N services (microservices). A React+Vite
 * frontend, a Cloudflare Worker backend, and a PHP service can live in
 * the same session, each in its own container, joined by a shared docker
 * network so they can address each other by hostname.
 *
 * `company_sandboxes` is kept as the "primary service" shortcut (first
 * service provisioned, a.k.a. `service_id = 'main'`). `company_sandbox_services`
 * is the authoritative list — the manager reads/writes per-service rows
 * here, and the primary row in `company_sandboxes` mirrors whichever
 * service is tagged as main.
 *
 * The shared docker network is named `mcp-sbx-net-<session_id>` and is
 * created on the first service provision, removed on the last destroy.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companySandboxServices035 = {
  version: 35,
  name: 'company_sandbox_services',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_sandbox_services (
        session_id         INTEGER NOT NULL
                           REFERENCES company_sessions(id) ON DELETE CASCADE,
        -- Stable per-session identifier for the microservice. Human-readable
        -- so it doubles as the in-network hostname (e.g. 'frontend', 'api').
        service_id         TEXT NOT NULL,
        -- Display label, falls back to service_id when empty.
        name               TEXT NOT NULL DEFAULT '',
        container_id       TEXT NOT NULL,
        runtime            TEXT NOT NULL
                           CHECK(runtime IN ('docker','podman','e2b')),
        -- Free-form stack key (e.g. 'react-ts', 'vue-ts', 'cf-worker',
        -- 'php-apache', 'vite-vanilla'). Validated by the scaffolder
        -- registry at runtime, not the DB.
        stack              TEXT NOT NULL,
        workdir            TEXT NOT NULL,
        host_port          INTEGER NOT NULL,
        limits_json        TEXT NOT NULL DEFAULT '{}',
        status             TEXT NOT NULL
                           CHECK(status IN ('provisioning','running','paused',
                                            'destroying','destroyed','error')),
        error              TEXT,
        -- When true, this service is the one mirrored into company_sandboxes
        -- (the "primary" preview iframe). Enforced as at-most-one via the
        -- partial unique index below.
        is_primary         INTEGER NOT NULL DEFAULT 0
                           CHECK(is_primary IN (0,1)),
        last_access_at_ms  INTEGER NOT NULL,
        paused_at_ms       INTEGER,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, service_id)
      );

      CREATE UNIQUE INDEX idx_company_sandbox_services_port
        ON company_sandbox_services(host_port)
        WHERE status != 'destroyed';

      CREATE UNIQUE INDEX idx_company_sandbox_services_container
        ON company_sandbox_services(container_id)
        WHERE status != 'destroyed';

      CREATE UNIQUE INDEX idx_company_sandbox_services_primary
        ON company_sandbox_services(session_id)
        WHERE is_primary = 1 AND status != 'destroyed';

      CREATE INDEX idx_company_sandbox_services_status
        ON company_sandbox_services(status, last_access_at_ms);
    `);
  },
};
