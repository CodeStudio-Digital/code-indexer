/**
 * Migration 107 — `agent_supervision` + `agent_supervision_incidents`.
 *
 * Sprint 4 Phase 2.4 — Persistence for the AgentSupervisor.
 *
 * `agent_supervision`: one row per tracked `agent_run_id`. The
 * supervisor writes the current state + heartbeat timestamp; on
 * restart, it reads the table to reconstruct in-memory state.
 *
 * Key signals available cross-restart:
 *   - `supervision_state` — the formal supervisor state (BOOTING /
 *     RUNNING_TURN / STUCK_* / QUARANTINED / TERMINAL / etc).
 *   - `last_heartbeat_at` — staleness detector. After a crash, rows
 *     with `state != TERMINAL` and `last_heartbeat_at` older than the
 *     watchdog window are `ghost_running` candidates.
 *   - `recovery_attempts` + `last_recovery_action` — circuit breaker
 *     state survives restart. A QUARANTINED agent stays quarantined.
 *
 * `agent_supervision_incidents`: audit trail of every incident emitted.
 * One row per stuck detection / recovery attempt / quarantine.
 *
 * The two tables are purely supervisor-internal — no FKs into
 * `company_agent_runs` because the supervisor needs to keep the
 * history for analysis even when the agent_run row is archived.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const agentSupervision107: Migration = {
  version: 107,
  name: 'agent_supervision',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_supervision (
        agent_run_id              INTEGER PRIMARY KEY,
        company_session_id        INTEGER NOT NULL,
        role                      TEXT NOT NULL,
        supervision_state         TEXT NOT NULL,
        state_entered_at          TEXT NOT NULL,
        last_heartbeat_at         TEXT NOT NULL,
        current_tool_use_id       TEXT,
        current_tool_name         TEXT,
        state_timeout_ms_override INTEGER,
        recovery_attempts         INTEGER NOT NULL DEFAULT 0,
        last_recovery_action      TEXT,
        last_recovery_at          TEXT,
        incident_count            INTEGER NOT NULL DEFAULT 0,
        created_at                TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_supervision_state
        ON agent_supervision(supervision_state, last_heartbeat_at);

      CREATE INDEX IF NOT EXISTS idx_supervision_session
        ON agent_supervision(company_session_id);

      CREATE TABLE IF NOT EXISTS agent_supervision_incidents (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_run_id        INTEGER,
        company_session_id  INTEGER,
        incident_kind       TEXT NOT NULL,
        from_state          TEXT,
        attempted_to_state  TEXT,
        detail              TEXT NOT NULL,
        diagnostic_json     TEXT,
        recovery_action     TEXT,
        recovery_outcome    TEXT,
        detected_at         TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_supervision_incidents_session
        ON agent_supervision_incidents(company_session_id, detected_at DESC);

      CREATE INDEX IF NOT EXISTS idx_supervision_incidents_kind
        ON agent_supervision_incidents(incident_kind, detected_at DESC);
    `);
  },
};
