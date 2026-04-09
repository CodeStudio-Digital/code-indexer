/**
 * Migration 014 — Tool configuration tables.
 *
 * Two tables:
 * 1. `disabled_tools_global` — tools disabled globally via the admin panel.
 *    Replaces the env-var-only `CODER_DISABLED_MCP_TOOLS` with a persistent,
 *    UI-managed mechanism. The env var still works as a complementary filter.
 *
 * 2. `session_disabled_tools` — tools disabled per coder session. Lets users
 *    fine-tune which tools are sent to the LLM, especially useful when a
 *    model has a low tool cap (e.g., GLM-5.1 at 50 tools).
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const toolConfigs014 = {
  version: 14,
  name: 'tool_configs',
  up(db: DB) {
    db.exec(`
      -- Globally disabled tools (admin panel)
      CREATE TABLE IF NOT EXISTS disabled_tools_global (
        tool_name   TEXT PRIMARY KEY,
        tier        TEXT NOT NULL DEFAULT 'bootstrap',
        source      TEXT NOT NULL DEFAULT 'native',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Per-session disabled tools
      CREATE TABLE IF NOT EXISTS session_disabled_tools (
        session_id  INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        tool_name   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool_name)
      );

      CREATE INDEX IF NOT EXISTS idx_sdt_session
        ON session_disabled_tools(session_id);
    `);
  },
};
