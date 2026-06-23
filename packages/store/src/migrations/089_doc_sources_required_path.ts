/**
 * Migration 089 — `doc_sources.crawl_required_path` (literal substring filter).
 *
 * Adds a "URL must contain this exact text" filter to a URL source's
 * crawl config. Sibling of `crawl_include_pattern` (which is a regex)
 * but presented to the dashboard user as a simple substring — easier
 * to reason about for the common case "stay inside this manual
 * version" (e.g. `/6000.3/Documentation/Manual/`).
 *
 * Nullable, no default — when absent, the crawler skips the substring
 * check entirely and falls back to the existing include/exclude regex
 * pair plus same-origin policy.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesRequiredPath089: Migration = {
  version: 89,
  name: 'doc_sources_required_path',
  up: (db: DB): void => {
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; probe with a SELECT and
    // skip when the column already exists (idempotent on re-applied dev DBs).
    try {
      db.exec(`SELECT crawl_required_path FROM doc_sources LIMIT 1`);
      return;
    } catch { /* column missing — go add it */ }
    db.exec(`ALTER TABLE doc_sources ADD COLUMN crawl_required_path TEXT`);
  },
};
