import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { coderSessionChapters208 } from '@mcp/store/migrations/208_coder_session_chapters.js';
import { coderCompactionReliability217 } from '@mcp/store/migrations/217_coder_compaction_reliability.js';
import * as attempts from '../compaction-attempts.js';

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      summary_boundary_id INTEGER,
      compaction_summary TEXT,
      updated_at TEXT
    );
    CREATE TABLE coder_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL
    );
    CREATE TABLE coder_turn_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      compaction_triggered INTEGER NOT NULL DEFAULT 0,
      summarizer_ran INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO coder_sessions (id) VALUES (1);
    INSERT INTO coder_messages (session_id, role, content_json)
      VALUES (1, 'user', '[]'), (1, 'assistant', '[]');
    INSERT INTO coder_turn_telemetry (session_id) VALUES (1);
  `);
  coderSessionChapters208.up(db);
  coderCompactionReliability217.up(db);
});

afterEach(() => db.close());

describe('durable compaction attempts', () => {
  it('repairs legacy booleans and exposes a degraded deterministic fallback', () => {
    const id = attempts.start(db, {
      session_id: 1,
      run_id: 'run-1',
      turn: 7,
      turn_telemetry_id: 1,
      trigger: 'context-overflow',
      provider_chain: [{ provider: 'aux', model: 'cheap' }, { provider: 'session', model: 'main' }],
      prompt_tokens_before: 80_000,
      history_chars_before: 320_000,
    });
    attempts.finish(db, id, {
      status: 'deterministic_fallback',
      strategy: 'deterministic',
      summarizer_ran: true,
      history_chars_after: 120_000,
      pruned_messages: 40,
      error_message: 'both providers timed out',
    });

    expect(db.prepare(`
      SELECT compaction_triggered, summarizer_ran FROM coder_turn_telemetry WHERE id = 1
    `).get()).toEqual({ compaction_triggered: 1, summarizer_ran: 1 });
    expect(attempts.chapterStatus(db, 1)).toMatchObject({
      state: 'degraded',
      unsummarized_messages: 2,
      counters: { attempts: 1, summarized: 0, deterministic_fallbacks: 1, checkpoint_failures: 0 },
      last_attempt: { status: 'deterministic_fallback', error_message: 'both providers timed out' },
    });
  });

  it('separates one root checkpoint failure from retries and stale-pending cascades', () => {
    const recordFailure = (trigger: string, error: string): void => {
      const id = attempts.start(db, {
        session_id: 1,
        run_id: 'run-1',
        turn: 8,
        trigger,
        provider_chain: [],
      });
      attempts.finish(db, id, {
        status: 'checkpoint_failed',
        strategy: 'summarizer',
        summarizer_ran: !trigger.startsWith('checkpoint_retry:'),
        error_message: error,
      });
    };

    recordFailure('milestone:error-resolved', 'unaligned');
    recordFailure('checkpoint_retry:milestone:error-resolved', 'unaligned');
    recordFailure('checkpoint_retry:milestone:error-resolved', 'unaligned');
    recordFailure('cumulative', 'prior checkpoint still pending: unaligned');

    expect(attempts.chapterStatus(db, 1).counters).toMatchObject({
      attempts: 2,
      checkpoint_failures: 1,
      checkpoint_retries: 2,
      checkpoint_blocked: 1,
      failures: 1,
    });
  });
});
