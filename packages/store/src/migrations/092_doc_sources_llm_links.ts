/**
 * Migration 092 — `doc_sources.crawl_llm_extract_links` flag.
 *
 * Opt-in toggle (default 0) that tells the crawler to call an LLM on
 * the seed page, after cheerio link extraction, to surface URLs cheerio
 * couldn't reach: data-* attributes, embedded JSON page maps
 * (`__NEXT_DATA__`, `pageMap`, etc.), script-body URL strings.
 *
 * Costs 1 LLM call per source (seed only — depth=0). Falls back
 * silently to cheerio-only when no `link_extractor` binding is
 * configured in `pipeline_provider_bindings`. See Addendum 4 of the
 * Documentação plan.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docSourcesLlmLinks092: Migration = {
  version: 92,
  name: 'doc_sources_llm_links',
  up: (db: DB): void => {
    // SQLite has no `ADD COLUMN IF NOT EXISTS`. Probe via SELECT and
    // skip when the column already exists — same idempotency pattern
    // as `089_doc_sources_required_path.ts`.
    try {
      db.exec(`SELECT crawl_llm_extract_links FROM doc_sources LIMIT 1`);
      return;
    } catch { /* column missing — go add it */ }
    db.exec(`ALTER TABLE doc_sources ADD COLUMN crawl_llm_extract_links INTEGER NOT NULL DEFAULT 0`);
  },
};
