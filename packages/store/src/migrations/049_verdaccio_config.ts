/**
 * Migration 047 — Verdaccio embedded npm registry singleton.
 *
 * Persists the configuration of the SHARED Verdaccio container that
 * Design System Creator sessions publish to and that Company sessions
 * `npm install` from. Same single-row pattern as `chrome_service_configs`
 * (045) — exactly one Verdaccio per host.
 *
 * Status lifecycle:
 *   stopped  → starting (enable initiated)
 *   starting → running   (healthcheck `/-/ping` returns 200)
 *   starting → error     (image pull / spawn / healthcheck failed)
 *   running  → stopped   (disable explicit)
 *   error    → starting  (operator hits "Restart" or boot recovery)
 *
 * `max_patch_versions_per_minor` controls auto-cleanup of patch
 * releases. When exceeded, oldest auto-bump patches are unpublished
 * (minor/major releases are never cleaned up). Default 50.
 *
 * `upstream_token` is the auth token Verdaccio uses (single-tenant for
 * v1 — multi-user auth is out of scope).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const verdaccioConfig049 = {
  version: 49,
  name: 'verdaccio_config',
  up(db: DB) {
    db.exec(`
      CREATE TABLE verdaccio_configs (
        id                              INTEGER PRIMARY KEY CHECK(id = 1),
        enabled                         INTEGER NOT NULL DEFAULT 0,
        image                           TEXT NOT NULL DEFAULT 'verdaccio/verdaccio:5',
        host_port                       INTEGER NOT NULL DEFAULT 4873,
        status                          TEXT NOT NULL DEFAULT 'stopped'
                                        CHECK(status IN ('stopped','starting','running','error')),
        container_id                    TEXT,
        last_error                      TEXT,
        upstream_token                  TEXT,
        storage_path                    TEXT,
        max_patch_versions_per_minor    INTEGER NOT NULL DEFAULT 50,
        started_at                      TEXT,
        created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO verdaccio_configs (id, enabled) VALUES (1, 0);
    `);
  },
};
