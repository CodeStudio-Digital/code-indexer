/**
 * Migration 069 — Per-turn telemetry for the coder runner.
 *
 * Goal: capture token + tool usage at every turn so we can answer
 * "where are tokens being spent?" with data instead of intuition.
 *
 * One row per (session_id, run_id, turn). Subagent turns are tagged via
 * `is_subagent` so we can split parent vs child cost in dashboards.
 *
 * Columns are nullable where the provider doesn't report the value
 * (e.g. cache_read_input_tokens on providers without prompt cache) so
 * existing code paths that report only the basics keep working.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderTurnTelemetry069: Migration = {
  version: 69,
  name: 'coder_turn_telemetry',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_turn_telemetry (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id                  INTEGER,
        run_id                      TEXT NOT NULL,
        turn                        INTEGER NOT NULL,
        is_subagent                 INTEGER NOT NULL DEFAULT 0,
        provider                    TEXT,
        model                       TEXT,
        input_tokens                INTEGER,
        output_tokens               INTEGER,
        cache_read_input_tokens     INTEGER,
        cache_creation_input_tokens INTEGER,
        thinking_tokens             INTEGER,
        history_chars               INTEGER,
        tool_count                  INTEGER NOT NULL DEFAULT 0,
        tools_called_json           TEXT,
        largest_tool_result_chars   INTEGER,
        compaction_triggered        INTEGER NOT NULL DEFAULT 0,
        summarizer_ran              INTEGER NOT NULL DEFAULT 0,
        paginate_count              INTEGER NOT NULL DEFAULT 0,
        created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_turn_telemetry_session
        ON coder_turn_telemetry(session_id, turn);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_turn_telemetry_run
        ON coder_turn_telemetry(run_id);
    `);
  },
};
