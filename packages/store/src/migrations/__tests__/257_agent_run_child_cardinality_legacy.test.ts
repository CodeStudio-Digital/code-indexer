import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { agentRunChildCardinality257 } from '../257_agent_run_child_cardinality.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE control_plane_sessions (
      session_id TEXT PRIMARY KEY
    );
    CREATE TABLE session_commands (
      command_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE
    );
    CREATE TABLE agent_runs (
      agent_run_id TEXT PRIMARY KEY,
      spec_version INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES control_plane_sessions(session_id) ON DELETE CASCADE,
      legacy_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL UNIQUE REFERENCES session_commands(command_id) ON DELETE CASCADE,
      owner_agent_run_id TEXT,
      parent_agent_run_id TEXT,
      spawn_depth INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      status TEXT NOT NULL,
      wait_mode TEXT NOT NULL,
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
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE agent_run_attempts (
      attempt_id TEXT PRIMARY KEY,
      agent_run_id TEXT NOT NULL REFERENCES agent_runs(agent_run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      UNIQUE(agent_run_id, ordinal)
    );

    INSERT INTO coder_sessions (id) VALUES (1);
    INSERT INTO control_plane_sessions (session_id) VALUES ('session:legacy');
    INSERT INTO session_commands (command_id, session_id)
      VALUES ('command:legacy', 'session:legacy');
    INSERT INTO agent_runs (
      agent_run_id, spec_version, session_id, legacy_session_id, command_id,
      spawn_depth, role, agent_definition_id, status, wait_mode,
      requested_capability_profile, created_at, updated_at
    ) VALUES (
      'run:legacy', 1, 'session:legacy', 1, 'command:legacy',
      0, 'build', 'build', 'running', 'foreground',
      'navigate', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO agent_run_attempts (attempt_id, agent_run_id, ordinal)
      VALUES ('attempt:legacy', 'run:legacy', 1);
    UPDATE agent_runs SET active_attempt_id = 'attempt:legacy'
      WHERE agent_run_id = 'run:legacy';
  `);
});

afterEach(() => db?.close());

describe('migration 257 — deployed legacy control-plane schema', () => {
  it('repairs missing composite parent keys before rebuilding agent_runs', () => {
    expect(() => agentRunChildCardinality257.up(db)).not.toThrow();

    expect(db.prepare(`
      SELECT agent_run_id, active_attempt_id FROM agent_runs
    `).get()).toEqual({
      agent_run_id: 'run:legacy',
      active_attempt_id: 'attempt:legacy',
    });
    expect(db.prepare(`
      SELECT attempt_id, agent_run_id FROM agent_run_attempts
    `).get()).toEqual({
      attempt_id: 'attempt:legacy',
      agent_run_id: 'run:legacy',
    });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN ('idx_session_commands_identity', 'idx_agent_run_attempts_identity')
       ORDER BY name
    `).all()).toEqual([
      { name: 'idx_agent_run_attempts_identity' },
      { name: 'idx_session_commands_identity' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
