/**
 * Migration 034 — Persistent sandbox↔container mapping.
 *
 * Before this, the SandboxManager kept `session_id → container` state only
 * in memory. Consequences:
 *   - API server restart destroyed the mapping; the "orphan reaper" had
 *     to re-discover containers via labels and save a tar archive to
 *     survive — expensive and fragile.
 *   - TTL eviction always DESTROYED the container (with optional archive
 *     snapshot) and any come-back paid ~90s reprovisioning cost.
 *   - No audit history: "why did session 47 lose its container at 2am?"
 *     was unanswerable.
 *
 * With this table:
 *   - `SandboxManager` boots, loads non-destroyed rows, reconciles with
 *     the OCI runtime (inspect each container). Living ones are reclaimed
 *     in-place; paused ones are just restarted (~5s); gone ones fall back
 *     to the archive-restore path.
 *   - TTL reaper becomes two-tier: soft (pause) vs hard (destroy).
 *   - Every state transition is recorded; `updated_at` is the audit trail.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companySandboxes034 = {
  version: 34,
  name: 'company_sandboxes',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_sandboxes (
        -- 1:1 with company_sessions: a session has at most one sandbox.
        -- Cascade delete so a session purge cleans this up automatically.
        session_id         INTEGER PRIMARY KEY
                           REFERENCES company_sessions(id) ON DELETE CASCADE,
        container_id       TEXT NOT NULL,
        runtime            TEXT NOT NULL
                           CHECK(runtime IN ('docker','podman','e2b')),
        stack              TEXT NOT NULL,
        workdir            TEXT NOT NULL,
        host_port          INTEGER NOT NULL,
        limits_json        TEXT NOT NULL DEFAULT '{}',
        -- State machine:
        --   provisioning → running
        --   running → paused   (soft TTL, filesystem preserved)
        --   paused  → running  (user returned, podman start + relaunch)
        --   *       → destroyed (hard TTL, explicit abort, or delete)
        status             TEXT NOT NULL
                           CHECK(status IN ('provisioning','running','paused',
                                            'destroying','destroyed','error')),
        error              TEXT,
        -- Epoch-ms timestamps let us do arithmetic (idle time) without
        -- parsing ISO strings. The manager writes wallclock Date.now().
        last_access_at_ms  INTEGER NOT NULL,
        paused_at_ms       INTEGER,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Ports are a scarce resource; enforce uniqueness so a bug in the
      -- port allocator can't assign the same host port twice. Filtered
      -- on non-destroyed so we can reuse ports after teardown.
      CREATE UNIQUE INDEX idx_company_sandboxes_port
        ON company_sandboxes(host_port)
        WHERE status != 'destroyed';

      CREATE UNIQUE INDEX idx_company_sandboxes_container
        ON company_sandboxes(container_id)
        WHERE status != 'destroyed';

      -- Fast "which sandboxes are alive?" on boot-time reconcile.
      CREATE INDEX idx_company_sandboxes_status
        ON company_sandboxes(status, last_access_at_ms);
    `);
  },
};
