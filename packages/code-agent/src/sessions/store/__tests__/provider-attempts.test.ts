import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { list, record } from '../provider-attempts.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      project_id INTEGER
    );
    INSERT INTO coder_sessions (id, project_id) VALUES (7, 11);
    CREATE TABLE coder_provider_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      project_id INTEGER,
      run_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      provider TEXT,
      model TEXT,
      status INTEGER,
      ok INTEGER NOT NULL,
      generation_id TEXT,
      request_id TEXT,
      upstream_provider TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      cost_usd REAL,
      retry_after TEXT,
      error_code TEXT,
      error_message TEXT,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, attempt)
    );
  `);
});

afterEach(() => db?.close());

describe('provider attempt telemetry store', () => {
  it('persists failures and upgrades the same attempt idempotently', () => {
    const id = record(db, {
      session_id: 7,
      run_id: 'run-1',
      turn: 2,
      attempt: 1,
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      status: 429,
      ok: false,
      generation_id: 'gen-429',
      retry_after: '2',
      error_message: 'rate limited',
      duration_ms: 15,
    });
    expect(id).toBeTypeOf('number');

    record(db, {
      session_id: 7,
      run_id: 'run-1',
      turn: 2,
      attempt: 1,
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      status: 200,
      ok: true,
      generation_id: 'gen-ok',
      input_tokens: 16_000,
      output_tokens: 100,
      cached_tokens: 15_500,
      cost_usd: 0.008,
      duration_ms: 40,
    });

    expect(list(db, 7)).toEqual([
      expect.objectContaining({
        id,
        project_id: 11,
        status: 200,
        ok: 1,
        generation_id: 'gen-ok',
        cached_tokens: 15_500,
        cost_usd: 0.008,
      }),
    ]);
  });

  it('returns an empty list before migration 253 exists', () => {
    db.exec('DROP TABLE coder_provider_attempts');
    expect(list(db, 7)).toEqual([]);
  });
});
