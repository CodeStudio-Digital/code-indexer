import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  asSessionId,
} from '@mcp/agent-runtime-contracts';
import { ControlPlaneStore } from '../../control-plane/control-plane-store.js';
import { hashControlPlanePayload } from '../../control-plane/codec.js';
import { controlPlaneFoundation251 } from '../251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '../252_control_plane_alignment.js';
import { agentRunChildCardinality257 } from '../257_agent_run_child_cardinality.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const SESSION_ID = asSessionId('session:257');
const COMMAND_ID = asSessionCommandId('command:257');
const ROOT_RUN_ID = asAgentRunId('agent-run:root:257');
const ROOT_ATTEMPT_ID = asAgentRunAttemptId('attempt:root:257');
const AT = '2026-01-01T00:00:00.000Z';

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  controlPlaneFoundation251.up(db);
  controlPlaneAlignment252.up(db);

  const payload = { task: 'root' };
  const result = new ControlPlaneStore(db, { journalEnabled: true }).acceptCommand({
    command: {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      commandId: COMMAND_ID,
      idempotencyKey: 'idem:257',
      kind: 'start',
      sessionId: SESSION_ID,
      actor: { actorId: 'test', actorType: 'user', source: 'http' },
      requestedAt: AT,
      correlationId: asCorrelationId('correlation:257'),
      payload,
    },
    payloadHash: hashControlPlanePayload(payload),
    run: {
      agentRunId: ROOT_RUN_ID,
      attemptId: ROOT_ATTEMPT_ID,
      role: 'build',
      agentDefinitionId: 'build',
      waitMode: 'foreground',
      requestedCapabilityProfile: 'navigate',
      executorOwnerId: 'worker:root',
      executorExpiresAt: '2099-01-01T00:00:00.000Z',
    },
  });
  expect(result.kind).toBe('accepted');
});

afterEach(() => db.close());

function insertRun(params: {
  id: string;
  parentId?: string;
  status?: 'starting' | 'completed';
  finishedAt?: string;
}): void {
  const status = params.status ?? 'starting';
  db.prepare(`
    INSERT INTO agent_runs (
      agent_run_id, spec_version, session_id, command_id,
      owner_agent_run_id, parent_agent_run_id, spawn_depth,
      role, agent_definition_id, status, wait_mode,
      requested_capability_profile, downgrade_reasons_json,
      created_at, finished_at, updated_at, version
    ) VALUES (?, 1, ?, ?, ?, ?, ?, 'subagent', 'explore', ?, 'foreground',
      'readonly', '[]', ?, ?, ?, 1)
  `).run(
    params.id,
    SESSION_ID,
    COMMAND_ID,
    params.parentId ?? null,
    params.parentId ?? null,
    params.parentId ? 1 : 0,
    status,
    AT,
    params.finishedAt ?? null,
    AT,
  );
}

function objectCount(type: 'index' | 'trigger', name: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?
  `).get(type, name) as { count: number }).count;
}

describe('migration 257 - AgentRun child cardinality', () => {
  it('is idempotent and preserves an existing root run + active attempt', () => {
    agentRunChildCardinality257.up(db);
    agentRunChildCardinality257.up(db);

    expect(objectCount('index', 'idx_agent_runs_root_command')).toBe(1);
    expect(objectCount('trigger', 'trg_agent_runs_wait_mode_immutable')).toBe(1);
    expect(db.prepare('SELECT agent_run_id FROM agent_runs').all()).toEqual([
      { agent_run_id: ROOT_RUN_ID },
    ]);
    expect(db.prepare(`
      SELECT attempt_id, agent_run_id, lease_status FROM agent_run_attempts
    `).get()).toEqual({
      attempt_id: ROOT_ATTEMPT_ID,
      agent_run_id: ROOT_RUN_ID,
      lease_status: 'active',
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps one root per command but allows multiple child runs for that command', () => {
    agentRunChildCardinality257.up(db);

    expect(() => insertRun({ id: 'agent-run:duplicate-root' }))
      .toThrow(/UNIQUE constraint failed: agent_runs\.command_id/);

    insertRun({ id: 'agent-run:child:1', parentId: ROOT_RUN_ID });
    insertRun({ id: 'agent-run:child:2', parentId: ROOT_RUN_ID });

    const rows = db.prepare(`
      SELECT agent_run_id, parent_agent_run_id, spawn_depth
      FROM agent_runs ORDER BY agent_run_id
    `).all();
    expect(rows).toEqual([
      { agent_run_id: 'agent-run:child:1', parent_agent_run_id: ROOT_RUN_ID, spawn_depth: 1 },
      { agent_run_id: 'agent-run:child:2', parent_agent_run_id: ROOT_RUN_ID, spawn_depth: 1 },
      { agent_run_id: ROOT_RUN_ID, parent_agent_run_id: null, spawn_depth: 0 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves the terminal-state CHECK and the wait_mode immutability trigger', () => {
    agentRunChildCardinality257.up(db);

    expect(() => insertRun({
      id: 'agent-run:invalid-terminal',
      parentId: ROOT_RUN_ID,
      status: 'completed',
      // finishedAt intentionally absent
    })).toThrow(/CHECK constraint failed/);

    insertRun({
      id: 'agent-run:valid-terminal',
      parentId: ROOT_RUN_ID,
      status: 'completed',
      finishedAt: AT,
    });
    expect(db.prepare(`
      SELECT status, finished_at FROM agent_runs WHERE agent_run_id = ?
    `).get('agent-run:valid-terminal')).toEqual({ status: 'completed', finished_at: AT });

    expect(() => db.prepare(`
      UPDATE agent_runs SET wait_mode = 'background' WHERE agent_run_id = ?
    `).run(ROOT_RUN_ID)).toThrow(/immutable AgentRunSpec snapshot/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back and restores foreign_keys when the rebuild fails inside its transaction', () => {
    // Force CREATE TABLE agent_runs_new to fail after foreign_keys was turned
    // OFF. The migration's transaction must roll back and its finally block
    // must restore FK enforcement before propagating the error.
    db.exec('CREATE TABLE agent_runs_new (sentinel INTEGER)');

    expect(() => agentRunChildCardinality257.up(db)).toThrow(/already exists/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT agent_run_id FROM agent_runs').all()).toEqual([
      { agent_run_id: ROOT_RUN_ID },
    ]);
    expect(objectCount('index', 'idx_agent_runs_root_command')).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
