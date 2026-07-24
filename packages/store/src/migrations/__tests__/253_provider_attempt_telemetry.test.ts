import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { providerAttemptTelemetry253 } from '../253_provider_attempt_telemetry.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      project_id INTEGER
    );
  `);
});

afterEach(() => db?.close());

describe('migration 253 — provider attempt telemetry', () => {
  it('creates the attempt audit table and enforces run/attempt idempotency', () => {
    providerAttemptTelemetry253.up(db);
    db.prepare(`
      INSERT INTO coder_provider_attempts (
        run_id, turn, attempt, ok, duration_ms
      ) VALUES ('run-1', 1, 1, 0, 12)
    `).run();

    expect(() => db.prepare(`
      INSERT INTO coder_provider_attempts (
        run_id, turn, attempt, ok, duration_ms
      ) VALUES ('run-1', 1, 1, 1, 15)
    `).run()).toThrow();

    const columns = db.prepare('PRAGMA table_info(coder_provider_attempts)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'generation_id',
      'status',
      'cached_tokens',
      'cost_usd',
      'error_message',
    ]));
  });
});
