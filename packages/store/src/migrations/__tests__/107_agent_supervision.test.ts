/**
 * Migration 107 — agent_supervision + agent_supervision_incidents.
 *
 * Pin de invariantes:
 *   - Cria as duas tabelas com schema esperado pelo
 *     `SqliteSupervisionPersistence` em packages/company
 *   - Cria os 3 índices (supervision_state, session, incidents_session,
 *     incidents_kind)
 *   - Idempotente — segunda execução não falha (IF NOT EXISTS)
 *   - PK em agent_supervision é agent_run_id (1 row por agent)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { agentSupervision107 } from '../107_agent_supervision.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration 107 — agent_supervision', () => {
  it('creates agent_supervision table with expected columns', () => {
    agentSupervision107.up(db);
    const cols = db
      .prepare(`PRAGMA table_info(agent_supervision)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('agent_run_id')).toBe(true);
    expect(names.has('company_session_id')).toBe(true);
    expect(names.has('role')).toBe(true);
    expect(names.has('supervision_state')).toBe(true);
    expect(names.has('state_entered_at')).toBe(true);
    expect(names.has('last_heartbeat_at')).toBe(true);
    expect(names.has('current_tool_use_id')).toBe(true);
    expect(names.has('current_tool_name')).toBe(true);
    expect(names.has('state_timeout_ms_override')).toBe(true);
    expect(names.has('recovery_attempts')).toBe(true);
    expect(names.has('incident_count')).toBe(true);
    expect(names.has('created_at')).toBe(true);
    expect(names.has('updated_at')).toBe(true);
  });

  it('creates agent_supervision_incidents table', () => {
    agentSupervision107.up(db);
    const cols = db
      .prepare(`PRAGMA table_info(agent_supervision_incidents)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('id')).toBe(true);
    expect(names.has('agent_run_id')).toBe(true);
    expect(names.has('incident_kind')).toBe(true);
    expect(names.has('detail')).toBe(true);
    expect(names.has('detected_at')).toBe(true);
    expect(names.has('resolved_at')).toBe(true);
  });

  it('creates the four indexes', () => {
    agentSupervision107.up(db);
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = new Set(idx.map((i) => i.name));
    expect(names.has('idx_supervision_state')).toBe(true);
    expect(names.has('idx_supervision_session')).toBe(true);
    expect(names.has('idx_supervision_incidents_session')).toBe(true);
    expect(names.has('idx_supervision_incidents_kind')).toBe(true);
  });

  it('is idempotent — second run is a no-op', () => {
    agentSupervision107.up(db);
    expect(() => agentSupervision107.up(db)).not.toThrow();
  });

  it('PK on agent_run_id enforces single-row-per-agent', () => {
    agentSupervision107.up(db);
    const insert = db.prepare(`
      INSERT INTO agent_supervision (
        agent_run_id, company_session_id, role, supervision_state,
        state_entered_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(1, 100, 'qa', 'RUNNING_TURN', '2024-01-01', '2024-01-01');
    expect(() =>
      insert.run(1, 100, 'qa', 'AWAITING_TOOL', '2024-01-01', '2024-01-01'),
    ).toThrow();
  });

  it('agent_supervision_incidents.id is AUTOINCREMENT', () => {
    agentSupervision107.up(db);
    const insert = db.prepare(`
      INSERT INTO agent_supervision_incidents (
        agent_run_id, company_session_id, incident_kind, detail
      ) VALUES (?, ?, ?, ?)
    `);
    const r1 = insert.run(1, 100, 'stuck_detected', 'first');
    const r2 = insert.run(1, 100, 'stuck_detected', 'second');
    expect(r1.lastInsertRowid).toBe(1);
    expect(r2.lastInsertRowid).toBe(2);
  });
});
