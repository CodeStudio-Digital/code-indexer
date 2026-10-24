/**
 * Migration 101 — `doc_sources.crawl_browser_seed_only`.
 *
 * Hybrid render mode: use Chromium ONLY for the seed page (depth=0) so
 * the crawler can see JS-rendered navigation, then fall back to plain
 * HTTP for every discovered leaf URL. The leaves on most "SPA-shell"
 * docs sites (Unity ScriptReference, Docusaurus with hash-router nav,
 * Algolia-driven indices, …) are themselves plain HTML once you HAVE
 * the URL — the only reason `force_browser=1` was needed was to surface
 * the URLs in the first place.
 *
 * Cost comparison on a 1000-page Unity crawl:
 *   - `force_browser=1`         → ~15-30s × 1000 = 4-8 hours.
 *   - `browser_seed_only=1`     → ~15-30s + 100ms × 999 = ~2 min.
 *   - `llm_extract_links=1`     → ~1 LLM call seeds + cheerio leaves.
 *     (Works for sites where the JS hydrates pre-existing JSON the LLM
 *     can parse from the HTML; misses pure-client-side nav.)
 *
 * Priority when multiple flags are on (documented in the dialog help
 * text, enforced in `crawler.ts`):
 *   1. `force_browser`        → all pages via Chromium (most expensive).
 *   2. `browser_seed_only`    → seed via Chromium, leaves via plain.
 *   3. neither                → all plain (existing default).
 *
 * Companion to migrations 089 (`crawl_required_path`), 092
 * (`crawl_llm_extract_links`), and 099 (`crawl_force_browser`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesBrowserSeedOnly101: Migration = {
  version: 101,
  name: 'doc_sources_browser_seed_only',
  up: (db: DB): void => {
    // SQLite `ALTER TABLE ADD COLUMN` is not idempotent on its own; the
    // PRAGMA-guarded pattern mirrors migrations 092/099 so re-runs are
    // safe across the dev databases that already enabled docs.
    const cols = db
      .prepare(`PRAGMA table_info(doc_sources)`)
      .all() as Array<{ name: string }>;
    const hasColumn = cols.some((c) => c.name === 'crawl_browser_seed_only');
    if (hasColumn) return;

    db.exec(`
      ALTER TABLE doc_sources
        ADD COLUMN crawl_browser_seed_only INTEGER NOT NULL DEFAULT 0
    `);
  },
};
