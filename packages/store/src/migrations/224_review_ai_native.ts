/**
 * Migration 224 — AI-native review substrate (Onda 2 do review nativo de IA).
 *
 * Three pieces:
 *   - unified-finding columns on `session_file_review_comments`: `kind`
 *     (defect | missing_change | unfulfilled_obligation | scope_creep),
 *     `obligation_id` (join to the compiled intent contract) and
 *     `symbol_anchor` (enclosing-symbol name — survives the hunk-fingerprint
 *     invalidation that re-edits cause);
 *   - `session_intent_contracts`: the compiled intent contract (obligations
 *     JSON) cached per (session, source-hash) so re-reviews of an unchanged
 *     task list never pay a second model call;
 *   - `review_comment_fates`: one observed outcome per review comment
 *     (accepted | dismissed | reedited | ignored) — the ground truth that
 *     feeds suppression/calibration priors on later reviews.
 *
 * The review tables are CENTRAL-only (see project-db/trim/drop-list.ts), so
 * the ALTERs are guarded by a table-existence check for project DBs.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const reviewAiNative224: Migration = {
  version: 224,
  name: 'review_ai_native',
  up(db: DB): void {
    const hasCommentsTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_file_review_comments'`)
      .get();
    if (hasCommentsTable) {
      const cols = db.prepare(`PRAGMA table_info(session_file_review_comments)`).all() as Array<{
        name: string;
      }>;
      const has = (name: string): boolean => cols.some((c) => c.name === name);
      if (!has('kind')) {
        db.exec(`ALTER TABLE session_file_review_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'defect'`);
      }
      if (!has('obligation_id')) {
        db.exec(`ALTER TABLE session_file_review_comments ADD COLUMN obligation_id TEXT`);
      }
      if (!has('symbol_anchor')) {
        db.exec(`ALTER TABLE session_file_review_comments ADD COLUMN symbol_anchor TEXT`);
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_intent_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_kind TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        source_hash TEXT NOT NULL,
        obligations_json TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_kind, session_id, source_hash)
      );

      CREATE TABLE IF NOT EXISTS review_comment_fates (
        comment_id INTEGER PRIMARY KEY,
        session_kind TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        severity TEXT,
        file_path TEXT NOT NULL,
        outcome TEXT NOT NULL,
        observed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_review_comment_fates_agg
        ON review_comment_fates(category, severity, outcome);
    `);
  },
};
