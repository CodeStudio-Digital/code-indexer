import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { coderOrchestrationCheckpoints259 } from '../259_coder_orchestration_checkpoints.js';

describe('migration 259 - coder orchestration checkpoints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      INSERT INTO coder_sessions (id) VALUES (7);
    `);
  });

  it('adds private TTL checkpoints without changing existing session rows', () => {
    coderOrchestrationCheckpoints259.up(db);

    db.prepare(`
      INSERT INTO coder_orchestration_checkpoints (
        session_id, checkpoint_kind, scope_id, schema_version, privacy_class,
        payload_json, payload_hash, byte_size, created_at, updated_at, expires_at
      ) VALUES (7, 'workflow', 'wf-1', 1, 'session_private_redacted',
        '{"id":"wf-1"}', 'hash', 13, '2026-01-01', '2026-01-01', '2099-01-01')
    `).run();

    expect(db.prepare(`
      SELECT checkpoint_kind, scope_id, privacy_class, version
      FROM coder_orchestration_checkpoints
    `).get()).toEqual({
      checkpoint_kind: 'workflow',
      scope_id: 'wf-1',
      privacy_class: 'session_private_redacted',
      version: 1,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent for rolling/partial fixtures', () => {
    coderOrchestrationCheckpoints259.up(db);
    expect(() => coderOrchestrationCheckpoints259.up(db)).not.toThrow();
  });
});
