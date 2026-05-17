/**
 * Migration 059 — Agent inbox.
 *
 * Persistent message queue between subordinates of the same company
 * session. A subordinate can `send_to_agent(target_role, question)`
 * even when the target is busy: the row sits in `pending`, and when
 * the target's runner reaches an idle status the lifecycle hook drains
 * the inbox and injects the message as a prompt. The sender either
 * blocks on `wait=true` or returns immediately with the message id.
 *
 *   - `kind = 'question'` blocks the sender until the target answers.
 *   - `kind = 'notify'` is fire-and-forget; the sender does not wait.
 *
 * Status lifecycle: `pending → delivered → answered`. Operator/cycle
 * detection paths can transition to `cancelled` or `expired`.
 *
 * Either `to_role` or `to_agent_run_id` MUST be set — `to_role` covers
 * the "anyone playing this role" case, `to_agent_run_id` pins to a
 * specific run.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const agentInbox059: Migration = {
  version: 59,
  name: 'agent_inbox',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id  INTEGER NOT NULL
                              REFERENCES company_sessions(id) ON DELETE CASCADE,
        from_agent_run_id   INTEGER NOT NULL
                              REFERENCES company_agent_runs(id) ON DELETE CASCADE,
        from_role           TEXT NOT NULL,
        to_role             TEXT,
        to_agent_run_id     INTEGER
                              REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        kind                TEXT NOT NULL
                              CHECK(kind IN ('question','notify')),
        body                TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN ('pending','delivered','answered','cancelled','expired')),
        answer              TEXT,
        wait_token          TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at        TEXT,
        answered_at         TEXT,
        CHECK(to_role IS NOT NULL OR to_agent_run_id IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_session_status
        ON agent_inbox(company_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_inbox_to_role
        ON agent_inbox(company_session_id, to_role, status);
      CREATE INDEX IF NOT EXISTS idx_inbox_to_run
        ON agent_inbox(to_agent_run_id, status);
      CREATE INDEX IF NOT EXISTS idx_inbox_from_run
        ON agent_inbox(from_agent_run_id, status);
    `);
  },
};
