/**
 * Migration 106 — per-agent board watermarks.
 *
 * The master already tracks `board_seen_id` via `BoardBridge`, but
 * subordinate agents have to keep `since_id` in their own heads turn
 * after turn (wasting tokens + propenso a duplicar leituras after
 * reactivation). This table generalises the watermark to every
 * `(company_session, agent_run)` pair so `read_board({mark_seen: true,
 * from_watermark: true})` becomes the idiomatic incremental read.
 *
 * The schema is intentionally tiny — one row per agent. We don't store
 * a history of watermarks; only the latest. `updated_at` is for
 * debugging only.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const agentBoardWatermarks106: Migration = {
  version: 106,
  name: 'agent_board_watermarks',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_board_watermarks (
        company_session_id INTEGER NOT NULL,
        agent_run_id       INTEGER NOT NULL,
        last_seen_board_id INTEGER NOT NULL,
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (company_session_id, agent_run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_board_watermarks_session
        ON agent_board_watermarks(company_session_id);
    `);
  },
};
