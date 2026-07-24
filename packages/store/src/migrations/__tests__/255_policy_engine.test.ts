import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '../255_policy_engine.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((r) => r.name);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
  policyEngine255.up(db); // idempotent
});

afterEach(() => db.close());

describe('migration 255 - policy engine', () => {
  it('creates the five additive policy/catalog tables idempotently', () => {
    expect(tableNames()).toEqual(expect.arrayContaining([
      'capability_descriptors',
      'policy_decision_comparisons',
      'policy_decisions',
      'policy_grants',
      'resolved_capability_sets',
    ]));
  });

  it('enforces the once-grant CAS: exactly one consumer wins', () => {
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO policy_grants (
        grant_id, subject_json, duration, binding_json, policy_version, nonce,
        created_at, expires_at
      ) VALUES ('grant:1', '{}', 'once', '{}', 'v1', 'nonce-1', ?, '2099-01-01T00:00:00.000Z')
    `).run(at);

    const cas = db.prepare(`
      UPDATE policy_grants SET consumption_status = 'consumed', consumed_by_tool_use_id = ?, consumed_at = ?
      WHERE grant_id = 'grant:1' AND nonce = 'nonce-1' AND consumption_status = 'unconsumed'
    `);
    const first = cas.run('tu-1', at);
    const second = cas.run('tu-2', at);
    expect(first.changes).toBe(1);
    expect(second.changes).toBe(0);
    expect(db.prepare("SELECT consumed_by_tool_use_id FROM policy_grants WHERE grant_id = 'grant:1'").get())
      .toEqual({ consumed_by_tool_use_id: 'tu-1' });
  });

  it('rejects a once grant without binding/expiry via CHECK', () => {
    expect(() => db.prepare(`
      INSERT INTO policy_grants (grant_id, subject_json, duration, policy_version, nonce, created_at)
      VALUES ('grant:bad', '{}', 'once', 'v1', 'nonce-bad', '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
  });

  it('rejects an invalid legacy_effect in comparisons', () => {
    db.prepare(`
      INSERT INTO policy_decisions (decision_id, capability_id, capability_version, effect, reason_code, policy_version, decided_at)
      VALUES ('dec:1', 'cap:1', '1', 'allow', 'ok', 'v1', '2026-01-01T00:00:00.000Z')
    `).run();
    expect(() => db.prepare(`
      INSERT INTO policy_decision_comparisons (
        comparison_id, decision_id, capability_id, legacy_effect, shadow_effect, agreement, compared_at
      ) VALUES ('cmp:1', 'dec:1', 'cap:1', 'maybe', 'allow', 1, '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
  });
});
