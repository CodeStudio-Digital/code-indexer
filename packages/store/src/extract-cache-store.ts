/**
 * ExtractCacheStore — SQLite backing for the content-keyed tree-sitter
 * extraction cache (JetBrains "shared indexes" short-circuit, local slice).
 *
 * One GLOBAL, disposable DB (lives beside index.db in the mcp data dir):
 * rows key on (content_hash, ext, extractor_version), so identical file
 * content — across projects, or the same project after a branch revert —
 * resolves to the already-parsed analysis instead of a re-parse. Being a
 * cache, there are NO migrations: the schema is CREATE IF NOT EXISTS and a
 * version bump simply strands (then prunes) old rows. Safe to delete on disk.
 *
 * WAL + busy_timeout because index workers and the main process may hold
 * connections concurrently (same reasoning as the per-project index DBs).
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export interface ExtractCacheHit {
  language: string;
  analysis_json: string;
  touched_at: number;
}

export class ExtractCacheStore {
  private db: DB;
  private stmtGet;
  private stmtPut;
  private stmtTouch;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extract_cache (
        content_hash      TEXT    NOT NULL,
        ext               TEXT    NOT NULL,
        extractor_version INTEGER NOT NULL,
        language          TEXT    NOT NULL,
        analysis_json     TEXT    NOT NULL,
        touched_at        INTEGER NOT NULL,
        PRIMARY KEY (content_hash, ext, extractor_version)
      );
      CREATE INDEX IF NOT EXISTS idx_extract_cache_touched ON extract_cache(touched_at);
    `);
    this.stmtGet = this.db.prepare<[string, string, number], ExtractCacheHit>(
      'SELECT language, analysis_json, touched_at FROM extract_cache WHERE content_hash = ? AND ext = ? AND extractor_version = ?',
    );
    this.stmtPut = this.db.prepare(
      `INSERT OR REPLACE INTO extract_cache (content_hash, ext, extractor_version, language, analysis_json, touched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtTouch = this.db.prepare(
      'UPDATE extract_cache SET touched_at = ? WHERE content_hash = ? AND ext = ? AND extractor_version = ?',
    );
  }

  get(contentHash: string, ext: string, extractorVersion: number): ExtractCacheHit | null {
    return this.stmtGet.get(contentHash, ext, extractorVersion) ?? null;
  }

  put(
    contentHash: string, ext: string, extractorVersion: number,
    language: string, analysisJson: string, touchedAt: number,
  ): void {
    this.stmtPut.run(contentHash, ext, extractorVersion, language, analysisJson, touchedAt);
  }

  /** LRU recency stamp — callers throttle (an UPDATE per hit would double writes). */
  touch(contentHash: string, ext: string, extractorVersion: number, touchedAt: number): void {
    this.stmtTouch.run(touchedAt, contentHash, ext, extractorVersion);
  }

  /**
   * Opportunistic cleanup (called once at open): drop rows not touched since
   * `cutoffMs` — which also sweeps rows stranded by an EXTRACTOR_VERSION bump
   * — then enforce a hard row cap by evicting the least-recently-touched.
   */
  prune(cutoffMs: number, maxRows = 200_000): number {
    let removed = this.db.prepare('DELETE FROM extract_cache WHERE touched_at < ?').run(cutoffMs).changes;
    const over = this.count() - maxRows;
    if (over > 0) {
      removed += this.db.prepare(
        `DELETE FROM extract_cache WHERE rowid IN (
           SELECT rowid FROM extract_cache ORDER BY touched_at ASC LIMIT ?)`,
      ).run(over).changes;
    }
    return removed;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM extract_cache').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
