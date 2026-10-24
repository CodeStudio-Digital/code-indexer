/**
 * Migration 094 — Master inbox sentinel.
 *
 * Phase A of the "living company" restructure: subordinates can address
 * the master via the existing `agent_inbox` table by using the sentinel
 * `to_role = '__master__'`. No schema change is needed because `to_role`
 * is a free-form TEXT column already (see migration 059), and the
 * `CHECK(to_role IS NOT NULL OR to_agent_run_id IS NOT NULL)` constraint
 * is satisfied by the sentinel itself.
 *
 * What this migration does add is a partial index that makes the
 * `MasterInboxRouter` drain query (look up pending master messages for a
 * given session) O(log n) on sessions with deep peer-to-peer traffic.
 * The router would otherwise scan `idx_inbox_session_status` together
 * with every subordinate message; the partial index restricts the scan
 * to master-bound rows.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const masterInboxSentinel094: Migration = {
  version: 94,
  name: 'master_inbox_sentinel',
  up(db: DB) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_master
        ON agent_inbox(company_session_id, status)
        WHERE to_role = '__master__';
    `);
  },
};
