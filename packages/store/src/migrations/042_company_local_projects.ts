/**
 * Migration 042 — Local host-process projects (non-container runtime).
 *
 * Sibling of `company_sandbox_services` (migration 035) for projects
 * that run AS A HOST PROCESS rather than inside a Podman/Docker
 * container. Keeping it in a separate table — instead of bolting
 * a `runtime_kind` discriminator onto the sandbox table — because:
 *
 *   1. The sandbox tables carry a `CHECK(runtime IN ('docker','podman','e2b'))`
 *      that SQLite can't loosen without a full table rebuild.
 *   2. A local project has fundamentally different fields (program,
 *      argv, cwd) and none of the container fields (container_id,
 *      limits). Adding nullable columns for each would invite bugs
 *      where code reads the wrong shape.
 *   3. Port-allocation collisions across both runtimes are prevented
 *      by the shared in-memory `PortAllocator` singleton, not by a
 *      DB constraint.
 *
 * Rows are keyed by `session_id` (1:1 like the legacy primary table).
 * At most one local project per session in the MVP — the UI surfaces
 * it as a single "host" row alongside any container services.
 *
 * Lifecycle:
 *   provisioning → running → destroyed
 *   provisioning → error   (spawn failed, readiness probe failed)
 *   running       → destroyed (user stop, server restart reconciliation)
 *
 * `paused` does not apply (the host process can't be frozen cheaply).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyLocalProjects042 = {
  version: 42,
  name: 'company_local_projects',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_local_projects (
        session_id         INTEGER PRIMARY KEY
                           REFERENCES company_sessions(id) ON DELETE CASCADE,
        -- Project root on the host filesystem (the cwd of the spawned process).
        cwd                TEXT NOT NULL,
        -- Manifest kind the synthesizer observed (node, python, go, rust, ruby).
        manifest_kind      TEXT NOT NULL,
        -- Bare executable name from the allowlist (npm, npx, python, ...).
        program            TEXT NOT NULL,
        -- JSON array of argv entries (no shell parsing).
        args_json          TEXT NOT NULL,
        -- JSON object of env vars set on spawn (excludes PORT/HOST which
        -- are always set by the manager).
        env_json           TEXT NOT NULL DEFAULT '{}',
        host_port          INTEGER NOT NULL,
        -- Short human-readable reason the command was picked (shown in UI).
        rationale          TEXT NOT NULL DEFAULT '',
        -- Was the command synthesized by the AI or by the deterministic fallback?
        synth_source       TEXT NOT NULL
                           CHECK(synth_source IN ('ai','fallback','fallback-after-ai-failure')),
        status             TEXT NOT NULL
                           CHECK(status IN ('provisioning','running','destroying','destroyed','error')),
        error              TEXT,
        -- OS pid of the spawned process. Null before spawn completes and
        -- after destroy. Informational only; we never reattach post-restart.
        pid                INTEGER,
        last_access_at_ms  INTEGER NOT NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX idx_company_local_projects_port
        ON company_local_projects(host_port)
        WHERE status != 'destroyed';

      CREATE INDEX idx_company_local_projects_status
        ON company_local_projects(status, last_access_at_ms);
    `);
  },
};
