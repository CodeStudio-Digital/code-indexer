import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { controlPlaneFoundation251 } from '../251_control_plane_foundation.js';
import { controlPlaneAlignment252 } from '../252_control_plane_alignment.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

const AT = '2026-01-01T00:00:00.000Z';

function seedSession(sessionId: string): void {
  db.prepare(`
    INSERT INTO control_plane_sessions (session_id, version, created_at, updated_at)
    VALUES (?, 0, ?, ?)
  `).run(sessionId, AT, AT);
}

function insertEvent(eventId: string, type: string, eventClass: string): void {
  db.prepare(`
    INSERT INTO runtime_events (
      event_id, schema_version, event_class, partition_key, session_id,
      correlation_id, event_type, occurred_at, recorded_at,
      actor_json, payload_json, payload_hash, redaction_json
    ) VALUES (?, 1, ?, ?, ?, 'corr:1', ?, ?, ?, '{}', '{}', 'hash', '{}')
  `).run(eventId, eventClass, 'session:test', 'session:test', type, AT, AT);
}

function seedRun(agentRunId: string): void {
  db.prepare(`
    INSERT INTO session_commands (
      command_id, schema_version, session_id, idempotency_key, kind, payload_hash,
      status, actor_json, session_version, correlation_id, requested_at,
      created_at, updated_at
    ) VALUES (?, 1, 'session:test', ?, 'start', 'hash', 'accepted', '{}', 1, 'corr:1', ?, ?, ?)
  `).run(`command:${agentRunId}`, `idem:${agentRunId}`, AT, AT, AT);
  db.prepare(`
    INSERT INTO agent_runs (
      agent_run_id, spec_version, session_id, command_id, role, agent_definition_id,
      status, wait_mode, requested_capability_profile, downgrade_reasons_json,
      created_at, updated_at, version
    ) VALUES (?, 1, 'session:test', ?, 'build', 'build', 'running', 'foreground', 'auto', '[]', ?, ?, 1)
  `).run(agentRunId, `command:${agentRunId}`, AT, AT);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  controlPlaneFoundation251.up(db);
  seedSession('session:test');
});

afterEach(() => db.close());

describe('migration 252 - control plane alignment', () => {
  it('reclassifies existing agent_run.created events from C to A, once', () => {
    insertEvent('evt:created', 'agent_run.created', 'C');
    insertEvent('evt:started', 'agent_run.started', 'C');
    insertEvent('evt:other', 'tool.invocation.started', 'B');

    controlPlaneAlignment252.up(db);
    controlPlaneAlignment252.up(db);

    const rows = db.prepare(
      'SELECT event_id, event_class FROM runtime_events ORDER BY event_id',
    ).all() as Array<{ event_id: string; event_class: string }>;
    expect(rows).toEqual([
      { event_id: 'evt:created', event_class: 'A' },
      { event_id: 'evt:other', event_class: 'B' },
      { event_id: 'evt:started', event_class: 'C' },
    ]);
  });

  it('creates the divergence audit table', () => {
    controlPlaneAlignment252.up(db);

    db.prepare(`
      INSERT INTO control_plane_divergences (
        divergence_id, session_id, kind, legacy_state_json, control_plane_state_json, detected_at
      ) VALUES ('div:1', 'session:test', 'terminal_status_mismatch', '{}', '{}', ?)
    `).run(AT);
    expect(db.prepare('SELECT COUNT(*) AS count FROM control_plane_divergences').get())
      .toEqual({ count: 1 });
  });

  it('rejects updates to agent_runs.wait_mode but allows other columns', () => {
    seedRun('agent-run:1');
    controlPlaneAlignment252.up(db);

    expect(() => db.prepare(
      "UPDATE agent_runs SET wait_mode = 'background' WHERE agent_run_id = 'agent-run:1'",
    ).run()).toThrow(/wait_mode is an immutable/);

    db.prepare("UPDATE agent_runs SET status = 'completed', finished_at = ? WHERE agent_run_id = 'agent-run:1'")
      .run(AT);
    expect(db.prepare('SELECT status FROM agent_runs WHERE agent_run_id = ?').get('agent-run:1'))
      .toEqual({ status: 'completed' });
  });
});
