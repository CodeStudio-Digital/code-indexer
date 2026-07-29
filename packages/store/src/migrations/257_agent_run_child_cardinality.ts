import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Migration 257 — relax AgentRun command cardinality for durable children.
 *
 * Migration 251 used UNIQUE(command_id), which correctly enforced one root
 * AgentRun per accepted command during the control-plane shadow phase. Durable
 * subagents/workflow steps (Fase 3) are child AgentRuns that share the parent
 * turn's command, so the invariant becomes:
 *
 *   - at most one ROOT AgentRun per command (parent_agent_run_id IS NULL);
 *   - any number of CHILD AgentRuns per command, linked by parent/owner refs.
 *
 * SQLite cannot drop an inline UNIQUE constraint, therefore this is the
 * documented 12-step table rebuild. It runs outside the migration runner's
 * transaction so foreign_keys can be disabled before BEGIN. All rows, CHECKs,
 * FKs, indexes and the migration-252 wait_mode immutability trigger are
 * preserved. Only UNIQUE(command_id) is removed and replaced by the partial
 * unique root index.
 *
 * Some databases applied an earlier deployed form of migration 251 whose
 * parent tables had globally unique primary keys but not the redundant
 * composite UNIQUE keys later declared by the canonical migration source.
 * SQLite requires an exact UNIQUE parent key for composite FKs, so the rebuild
 * first installs compatible unique indexes for both legacy and fresh schemas.
 */
export const agentRunChildCardinality257: Migration = {
  version: 257,
  name: 'agent_run_child_cardinality',
  outsideTransaction: true,
  up(db: DB): void {
    // `agent_runs` ∈ CENTRAL_DROP_TABLES — a per-project DB runs this central
    // migration lineage but trims the control plane away, so the rebuild below
    // would throw `no such table` (see project-db/trim/drop-list.ts, migration 175).
    const present = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'
    `).get();
    if (!present) return;

    // Idempotency guard: this index only exists after the rebuild completed.
    const alreadyApplied = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_agent_runs_root_command'
    `).get();
    if (alreadyApplied) return;

    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_session_commands_identity
            ON session_commands(command_id, session_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_attempts_identity
            ON agent_run_attempts(attempt_id, agent_run_id);

          CREATE TABLE agent_runs_new (
            agent_run_id TEXT PRIMARY KEY,
            spec_version INTEGER NOT NULL CHECK (spec_version >= 1),
            session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
            legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
            command_id TEXT NOT NULL,
            owner_agent_run_id TEXT REFERENCES agent_runs_new(agent_run_id) ON DELETE SET NULL,
            parent_agent_run_id TEXT REFERENCES agent_runs_new(agent_run_id) ON DELETE SET NULL,
            spawn_depth INTEGER NOT NULL DEFAULT 0 CHECK (spawn_depth >= 0),
            role TEXT NOT NULL,
            agent_definition_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (
              'queued', 'starting', 'running', 'waiting', 'detached', 'stopping',
              'completed', 'failed', 'aborted', 'interrupted'
            )),
            wait_mode TEXT NOT NULL CHECK (wait_mode IN ('foreground', 'background')),
            requested_provider TEXT,
            requested_model TEXT,
            requested_reasoning_effort TEXT,
            requested_preset TEXT,
            requested_capability_profile TEXT NOT NULL,
            effective_provider TEXT,
            effective_model TEXT,
            effective_reasoning_effort TEXT,
            effective_preset TEXT,
            downgrade_reasons_json TEXT NOT NULL DEFAULT '[]',
            capability_set_ref TEXT,
            environment_id TEXT,
            workspace_lease_id TEXT,
            active_attempt_id TEXT,
            preset_resolution_ref TEXT,
            terminal_reason TEXT,
            transcript_ref TEXT,
            checkpoint_ref TEXT,
            result_ref TEXT,
            policy_snapshot_ref TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
            CHECK (
              (status IN ('completed', 'failed', 'aborted', 'interrupted') AND finished_at IS NOT NULL)
              OR (status NOT IN ('completed', 'failed', 'aborted', 'interrupted') AND finished_at IS NULL)
            ),
            UNIQUE(agent_run_id, session_id),
            FOREIGN KEY(command_id, session_id)
              REFERENCES session_commands(command_id, session_id) ON DELETE CASCADE,
            FOREIGN KEY(active_attempt_id, agent_run_id)
              REFERENCES agent_run_attempts(attempt_id, agent_run_id)
              DEFERRABLE INITIALLY DEFERRED
          );

          INSERT INTO agent_runs_new (
            agent_run_id, spec_version, session_id, legacy_session_id, command_id,
            owner_agent_run_id, parent_agent_run_id, spawn_depth,
            role, agent_definition_id, status, wait_mode,
            requested_provider, requested_model, requested_reasoning_effort, requested_preset,
            requested_capability_profile,
            effective_provider, effective_model, effective_reasoning_effort, effective_preset,
            downgrade_reasons_json, capability_set_ref, environment_id, workspace_lease_id,
            active_attempt_id, preset_resolution_ref, terminal_reason, transcript_ref,
            checkpoint_ref, result_ref, policy_snapshot_ref,
            created_at, started_at, finished_at, updated_at, version
          )
          SELECT
            agent_run_id, spec_version, session_id, legacy_session_id, command_id,
            owner_agent_run_id, parent_agent_run_id, spawn_depth,
            role, agent_definition_id, status, wait_mode,
            requested_provider, requested_model, requested_reasoning_effort, requested_preset,
            requested_capability_profile,
            effective_provider, effective_model, effective_reasoning_effort, effective_preset,
            downgrade_reasons_json, capability_set_ref, environment_id, workspace_lease_id,
            active_attempt_id, preset_resolution_ref, terminal_reason, transcript_ref,
            checkpoint_ref, result_ref, policy_snapshot_ref,
            created_at, started_at, finished_at, updated_at, version
          FROM agent_runs;

          DROP TABLE agent_runs;
          ALTER TABLE agent_runs_new RENAME TO agent_runs;

          CREATE INDEX idx_agent_runs_session_created
            ON agent_runs(session_id, created_at DESC);
          CREATE INDEX idx_agent_runs_status
            ON agent_runs(status, updated_at DESC);
          CREATE UNIQUE INDEX idx_agent_runs_root_command
            ON agent_runs(command_id)
            WHERE parent_agent_run_id IS NULL;

          -- DROP TABLE removes table-owned triggers. Recreate the D-013
          -- immutable AgentRunSpec snapshot guard introduced by migration 252.
          CREATE TRIGGER trg_agent_runs_wait_mode_immutable
            BEFORE UPDATE OF wait_mode ON agent_runs
            FOR EACH ROW WHEN OLD.wait_mode <> NEW.wait_mode
            BEGIN
              SELECT RAISE(ABORT, 'agent_runs.wait_mode is an immutable AgentRunSpec snapshot (D-013)');
            END;
        `);

        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(
            `foreign_key_check found ${violations.length} violation(s) after agent_runs rebuild: ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
      });
      tx();
    } finally {
      // The migration runner expects FK enforcement restored even when the
      // rebuild throws and its manual transaction rolls back.
      db.pragma('foreign_keys = ON');
    }
  },
};
