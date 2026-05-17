/**
 * Migration 045 — Chrome Service singleton (admin-managed).
 *
 * Persists the configuration of the SHARED Playwright/Chromium
 * container that QA agents from any company session connect to via
 * WebSocket. Replaces the per-session sidecar architecture from v3.0
 * (never committed to main) — see plan v4.0 for the rationale.
 *
 * Single-row table (`CHECK(id = 1)`) — there is exactly one Chrome
 * Service per host. Enabled / disabled by the operator via the Admin
 * Panel. Backfill of `PLAYWRIGHT_WS_ENDPOINT` into existing company
 * sessions happens in `ChromeService.enable()` after the container is
 * confirmed healthy.
 *
 * Status lifecycle:
 *   stopped  → starting (enable initiated)
 *   starting → running   (healthcheck succeeded)
 *   starting → error     (image pull / spawn / healthcheck failed)
 *   running  → stopped   (disable explicit)
 *   error    → starting  (operator hits "Restart" or boot recovery)
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const chromeService045 = {
  version: 45,
  name: 'chrome_service',
  up(db: DB) {
    db.exec(`
      CREATE TABLE chrome_service_configs (
        id            INTEGER PRIMARY KEY CHECK(id = 1),
        enabled       INTEGER NOT NULL DEFAULT 0,
        image         TEXT NOT NULL DEFAULT 'mcr.microsoft.com/playwright:v1.59.1-jammy',
        host_port     INTEGER NOT NULL DEFAULT 9222,
        status        TEXT NOT NULL DEFAULT 'stopped'
                      CHECK(status IN ('stopped','starting','running','error')),
        container_id  TEXT,
        last_error    TEXT,
        started_at    TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO chrome_service_configs (id, enabled) VALUES (1, 0);
    `);
  },
};
