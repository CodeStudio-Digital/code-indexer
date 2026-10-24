import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

/**
 * Control-plane contract alignment (Fase 1).
 *
 * 1. Reclassify `agent_run.created` runtime events from class C to class A.
 *    The target contract (14-target-control-plane-contracts.md §15) lists
 *    "run created" as a command/control (A) event; the shadow foundation
 *    persisted it as lifecycle (C). Existing rows are corrected in place.
 * 2. Add `control_plane_divergences`, the audit sink for the shadow
 *    projection comparator (Fase 1D). It intentionally has NO foreign key on
 *    `command_id`/`agent_run_id`: a legitimate divergence kind is "control
 *    plane is missing the run/command that the legacy path produced", so the
 *    row must persist even when the referenced control-plane entity is absent.
 * 3. Enforce `agent_runs.wait_mode` immutability (D-013). `waitMode` is an
 *    immutable `AgentRunSpec` snapshot — foreground/background is caller wait
 *    behavior, not mutable run state — so any attempt to change it fails
 *    closed at the database boundary.
 */
export const controlPlaneAlignment252: Migration = {
  version: 252,
  name: 'control_plane_alignment',
  up(db: DB): void {
    // The control-plane tables ∈ CENTRAL_DROP_TABLES — a per-project DB runs this
    // central migration lineage but trims them away (see project-db/trim/drop-list.ts).
    // Without the guard the UPDATE and the trigger throw `no such table` and
    // crash-loop the boot. `runtime_events` and `agent_runs` both come from 251.
    if (!tableExists(db, 'runtime_events')) return;

    db.exec(`
      UPDATE runtime_events
        SET event_class = 'A'
        WHERE event_type = 'agent_run.created' AND event_class <> 'A';

      CREATE TABLE IF NOT EXISTS control_plane_divergences (
        divergence_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
        legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        command_id TEXT,
        agent_run_id TEXT,
        kind TEXT NOT NULL CHECK (length(kind) > 0),
        legacy_state_json TEXT NOT NULL,
        control_plane_state_json TEXT NOT NULL,
        detail TEXT,
        detected_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_control_plane_divergences_session_detected
        ON control_plane_divergences(session_id, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_control_plane_divergences_kind
        ON control_plane_divergences(kind, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_control_plane_divergences_run
        ON control_plane_divergences(agent_run_id);

      CREATE TRIGGER IF NOT EXISTS trg_agent_runs_wait_mode_immutable
        BEFORE UPDATE OF wait_mode ON agent_runs
        FOR EACH ROW WHEN OLD.wait_mode <> NEW.wait_mode
        BEGIN
          SELECT RAISE(ABORT, 'agent_runs.wait_mode is an immutable AgentRunSpec snapshot (D-013)');
        END;
    `);
  },
};
