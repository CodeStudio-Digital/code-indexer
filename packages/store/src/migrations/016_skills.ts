/**
 * Migration 016 — Skills system.
 *
 * Adds three tables:
 *   - skill_definitions: catalog of reusable prompt-based skills
 *   - skill_session_config: per-session enable/disable overrides
 *   - skill_usage_log: lightweight telemetry for skill invocations
 *
 * Skills are reusable prompt instructions that can be:
 *   - Injected into the system prompt (inline mode)
 *   - Registered as callable tools via invoke_skill (tool mode)
 *   - Invoked via /slash commands in the chat composer
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const skills016 = {
  version: 16,
  name: 'skills',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_definitions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        slash_command   TEXT,
        prompt_body     TEXT NOT NULL,
        scope           TEXT NOT NULL DEFAULT 'global',
        enabled         INTEGER NOT NULL DEFAULT 1,
        allowed_tools   TEXT,
        model_override  TEXT,
        provider_override TEXT,
        context_mode    TEXT NOT NULL DEFAULT 'inline',
        variables       TEXT NOT NULL DEFAULT '[]',
        sort_order      INTEGER NOT NULL DEFAULT 0,
        tags            TEXT NOT NULL DEFAULT '[]',
        path_patterns   TEXT,
        author          TEXT,
        version         TEXT NOT NULL DEFAULT '1.0.0',
        source          TEXT NOT NULL DEFAULT 'user',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_slash_command
        ON skill_definitions(slash_command)
        WHERE slash_command IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_skill_scope
        ON skill_definitions(scope);

      CREATE INDEX IF NOT EXISTS idx_skill_enabled
        ON skill_definitions(enabled);

      CREATE TABLE IF NOT EXISTS skill_session_config (
        session_id  INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        skill_id    TEXT NOT NULL REFERENCES skill_definitions(id) ON DELETE CASCADE,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, skill_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ssc_session
        ON skill_session_config(session_id);

      CREATE TABLE IF NOT EXISTS skill_usage_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        skill_id    TEXT NOT NULL,
        invoked_by  TEXT NOT NULL DEFAULT 'user',
        input_text  TEXT,
        duration_ms INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sul_session
        ON skill_usage_log(session_id);

      CREATE INDEX IF NOT EXISTS idx_sul_skill
        ON skill_usage_log(skill_id);
    `);
  },
};
