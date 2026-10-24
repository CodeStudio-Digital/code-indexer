/**
 * Migration 099 — `doc_sources.crawl_force_browser`.
 *
 * Per-source opt-in flag: when true, the doc crawler skips the
 * heuristic detection used by `EscalatingFetcher` (status code, body
 * size, SPA-shell pattern, cloudflare markers) and goes straight to
 * the browser backend for every page in the crawl.
 *
 * Motivation: docs sites with sidebars/nav populated by client-side
 * JavaScript (Unity ScriptReference, Algolia DocSearch-driven indices,
 * etc.) return a full HTML body of CONTENT but a SKELETON nav. None of
 * the existing `detectBlocked()` signals catch this: status is 200,
 * body is well over 500 chars, the `spa_shell` heuristic (text < 200
 * chars + ≥3 script tags) doesn't fire because the right-hand content
 * pane is substantial. The plain fetcher silently misses the entire
 * navigation tree, the LLM link extractor also reads the same pre-JS
 * HTML, and the crawl ends with 1 page indexed and zero leaf pages
 * found. Giving the operator an explicit "force browser" toggle is the
 * cleanest fix until a smarter heuristic (or per-domain rule) lands.
 *
 * Companion column for migrations 089 (`crawl_required_path`) and 092
 * (`crawl_llm_extract_links`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesForceBrowser099: Migration = {
  version: 99,
  name: 'doc_sources_force_browser',
  up: (db: DB): void => {
    // Idempotent guard — SQLite `ALTER TABLE ADD COLUMN` is not idempotent
    // on its own. Mirror the pattern of migration 092 (llm_extract_links)
    // so re-runs are safe across the existing dev databases.
    const cols = db
      .prepare(`PRAGMA table_info(doc_sources)`)
      .all() as Array<{ name: string }>;
    const hasColumn = cols.some((c) => c.name === 'crawl_force_browser');
    if (hasColumn) return;

    db.exec(`
      ALTER TABLE doc_sources
        ADD COLUMN crawl_force_browser INTEGER NOT NULL DEFAULT 0
    `);
  },
};
