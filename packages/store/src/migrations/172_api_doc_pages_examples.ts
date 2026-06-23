/**
 * Migration 172 — guide pages + saved examples for the API client (Docs Studio).
 *
 *   - api_doc_pages       → ordered markdown/MDX guide pages per collection
 *                           (narrative docs alongside the auto reference).
 *   - api_request_examples → saved REAL request+response snapshots per request
 *                           (the "docs that don't lie" examples). Stored bodies/
 *                           headers/url are REDACTED server-side before insert.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) — mirrors apiRequestHistory148. FK
 * cascade only fires when PRAGMA foreign_keys is ON, so the store also deletes
 * these children explicitly in deleteCollection / deleteRequest.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiDocPagesExamples172: Migration = {
  version: 172,
  name: 'api_doc_pages_examples',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_doc_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id INTEGER NOT NULL REFERENCES api_collections(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body_md TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(collection_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_api_doc_pages_collection
        ON api_doc_pages(collection_id, sort_order);

      CREATE TABLE IF NOT EXISTS api_request_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES api_requests(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        req_snapshot_json TEXT NOT NULL DEFAULT '{}',
        resp_status INTEGER,
        resp_status_text TEXT,
        resp_headers_json TEXT,
        resp_body TEXT,
        resp_content_type TEXT,
        resp_size INTEGER,
        redaction_count INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_api_examples_request
        ON api_request_examples(request_id, sort_order);
    `);
  },
};
