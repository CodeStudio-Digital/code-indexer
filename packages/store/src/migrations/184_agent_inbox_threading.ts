/**
 * Migration 184 — Agent inbox threading + priority (Phase 4 "real conversation").
 *
 * The inbox (migration 059) carried only flat `{from_role, body}` rows delivered
 * as isolated turns — no way to continue a conversation, reference the message
 * being answered, prioritize an urgent blocker over an FYI, or attach structured
 * context (which card/decision/file this is about). This adds:
 *
 *   - `thread_id`            — groups a conversation. NULL = the message is its
 *                              own root (readers coalesce id when NULL).
 *   - `reply_to_message_id`  — the message this one answers/continues.
 *   - `priority`             — 'low' | 'normal' | 'urgent'; claim order is
 *                              urgent-first so a blocker preempts a batch of FYIs.
 *   - `context_json`         — small JSON payload (card_id, decision_id, file refs).
 *
 * Also adds the `wait_token` index the blocking-answer lookup needs (the
 * getByWaitToken store method scans on it).
 *
 * Forward-idempotent + zero-impact: columns/indexes added only if missing;
 * existing rows default to priority='normal', NULL thread/reply/context.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const agentInboxThreading184: Migration = {
  version: 184,
  name: 'agent_inbox_threading',
  up: (db: DB): void => {
    // `agent_inbox` ∈ CENTRAL_DROP_TABLES — a per-project DB runs this central
    // migration lineage but trims the table away (see project-db/trim/drop-list.ts).
    // On a project DB created under an older build (no mig 184 yet) the table is
    // already gone when this runs on upgrade, so guard or the ALTER / CREATE INDEX
    // throws `no such table` and crash-loops the indexer worker. Mirrors mig 175.
    if (!tableExists(db, 'agent_inbox')) return;
    addColumnIfMissing(db, 'agent_inbox', 'thread_id', 'INTEGER');
    addColumnIfMissing(db, 'agent_inbox', 'reply_to_message_id', 'INTEGER');
    // No CHECK on ALTER (SQLite limitation) — validated in the app layer.
    addColumnIfMissing(db, 'agent_inbox', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
    addColumnIfMissing(db, 'agent_inbox', 'context_json', 'TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_wait_token
        ON agent_inbox(company_session_id, wait_token);
      CREATE INDEX IF NOT EXISTS idx_inbox_thread
        ON agent_inbox(company_session_id, thread_id);
    `);
  },
};
