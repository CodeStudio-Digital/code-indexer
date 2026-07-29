import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

export const controlPlaneFoundation251: Migration = {
  version: 251,
  name: 'control_plane_foundation',
  up(db: DB): void {
    // The control plane is CENTRAL-only (∈ CENTRAL_DROP_TABLES): every session,
    // command and run hangs off `coder_sessions`, which a per-project DB trims
    // away. Creating it there would only be undone by the next trim — and worse,
    // migration 257 would then take its table-rebuild path on a project DB, where
    // `ALTER TABLE … RENAME` reparses the whole schema and chokes on triggers
    // left pointing at other trimmed central tables. Mirrors migration 258.
    if (!tableExists(db, 'coder_sessions')) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS control_plane_sessions (
        session_id TEXT PRIMARY KEY,
        legacy_session_id INTEGER UNIQUE REFERENCES coder_sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_commands (
        command_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
        legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'start', 'send_message', 'attach', 'resume', 'fork', 'handoff', 'stop',
          'inject_message', 'resolve_interaction', 'resolve_tool_approval'
        )),
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'accepted', 'running', 'succeeded', 'rejected', 'cancelled', 'failed'
        )),
        actor_json TEXT NOT NULL,
        expected_session_version INTEGER CHECK (expected_session_version IS NULL OR expected_session_version >= 0),
        session_version INTEGER NOT NULL CHECK (session_version >= 1),
        correlation_id TEXT NOT NULL,
        agent_run_id TEXT,
        reason_code TEXT,
        error_ref TEXT,
        result_json TEXT,
        requested_at TEXT NOT NULL,
        deadline_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status IN ('succeeded', 'rejected', 'cancelled', 'failed') AND completed_at IS NOT NULL)
          OR (status IN ('accepted', 'running') AND completed_at IS NULL)
        ),
        UNIQUE(command_id, session_id),
        UNIQUE(session_id, idempotency_key, kind),
        FOREIGN KEY(agent_run_id, session_id)
          REFERENCES agent_runs(agent_run_id, session_id)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE INDEX IF NOT EXISTS idx_session_commands_session_created
        ON session_commands(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_commands_status
        ON session_commands(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_run_id TEXT PRIMARY KEY,
        spec_version INTEGER NOT NULL CHECK (spec_version >= 1),
        session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
        legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL,
        owner_agent_run_id TEXT REFERENCES agent_runs(agent_run_id) ON DELETE SET NULL,
        parent_agent_run_id TEXT REFERENCES agent_runs(agent_run_id) ON DELETE SET NULL,
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
        UNIQUE(command_id),
        FOREIGN KEY(command_id, session_id)
          REFERENCES session_commands(command_id, session_id) ON DELETE CASCADE,
        FOREIGN KEY(active_attempt_id, agent_run_id)
          REFERENCES agent_run_attempts(attempt_id, agent_run_id)
          DEFERRABLE INITIALLY DEFERRED
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_created
        ON agent_runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status
        ON agent_runs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS agent_run_attempts (
        attempt_id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL REFERENCES agent_runs(agent_run_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        trigger TEXT NOT NULL CHECK (trigger IN (
          'initial', 'resume', 'provider_fallback', 'worker_recovery'
        )),
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'terminal')),
        executor_owner_id TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 1),
        lease_status TEXT NOT NULL CHECK (lease_status IN ('active', 'expired', 'released', 'fenced')),
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        runner_run_id TEXT,
        provider_request_refs_json TEXT NOT NULL DEFAULT '[]',
        checkpoint_input_ref TEXT,
        terminal_reason TEXT,
        error_ref TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        CHECK (
          (status = 'terminal' AND lease_status IN ('expired', 'released', 'fenced')
            AND released_at IS NOT NULL AND finished_at IS NOT NULL)
          OR (status IN ('starting', 'running') AND lease_status = 'active'
            AND released_at IS NULL AND finished_at IS NULL)
        ),
        UNIQUE(attempt_id, agent_run_id),
        UNIQUE(agent_run_id, ordinal)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_attempts_one_active
        ON agent_run_attempts(agent_run_id)
        WHERE status IN ('starting', 'running') AND lease_status = 'active';
      CREATE INDEX IF NOT EXISTS idx_agent_run_attempts_lease
        ON agent_run_attempts(lease_status, expires_at);

      CREATE TABLE IF NOT EXISTS runtime_events (
        global_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        event_class TEXT NOT NULL CHECK (event_class IN ('A', 'B', 'C', 'D', 'E', 'F')),
        partition_key TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
        legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        command_id TEXT,
        agent_run_id TEXT,
        attempt_id TEXT,
        workflow_id TEXT,
        workflow_step_id TEXT,
        operation_id TEXT,
        tool_use_id TEXT,
        parent_event_id TEXT REFERENCES runtime_events(event_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
        causation_id TEXT,
        correlation_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT,
        redaction_json TEXT NOT NULL,
        CHECK (agent_run_id IS NULL OR command_id IS NOT NULL),
        CHECK (attempt_id IS NULL OR agent_run_id IS NOT NULL),
        FOREIGN KEY(command_id, session_id)
          REFERENCES session_commands(command_id, session_id) ON DELETE CASCADE,
        FOREIGN KEY(agent_run_id, session_id)
          REFERENCES agent_runs(agent_run_id, session_id) ON DELETE CASCADE,
        FOREIGN KEY(attempt_id, agent_run_id)
          REFERENCES agent_run_attempts(attempt_id, agent_run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_events_partition_seq
        ON runtime_events(partition_key, global_seq);
      CREATE INDEX IF NOT EXISTS idx_runtime_events_session_seq
        ON runtime_events(session_id, global_seq);
      CREATE INDEX IF NOT EXISTS idx_runtime_events_run_seq
        ON runtime_events(agent_run_id, global_seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_idempotency
        ON runtime_events(partition_key, event_type, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS runtime_projection_cursors (
        projection_id TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        last_global_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_global_seq >= 0),
        projection_version TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(projection_id, partition_key)
      );
    `);
  },
};
