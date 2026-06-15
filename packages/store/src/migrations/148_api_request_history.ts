/**
 * Migration 148 — API client request history (timeline).
 *
 * One row per "send" of an api_requests row: status, ok flag, duration, URL and
 * (on transport failure) the error. Backs the per-request Timeline tab so the
 * user sees how a request behaved over time, not just its last_status. Capped
 * per request by the store (pruneRequestHistory) so it never grows unbounded.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) — mirrors apiCollections147.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiRequestHistory148: Migration = {
  version: 148,
  name: 'api_request_history',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_request_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES api_requests(id) ON DELETE CASCADE,
        status INTEGER,
        ok INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        url TEXT,
        error TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_history_request
        ON api_request_history(request_id, id DESC);
    `);
  },
};
