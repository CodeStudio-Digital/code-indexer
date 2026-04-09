/**
 * Migration 017 — Cached tool list per external MCP server.
 *
 * Populated on test/connect, read by admin panels and session tools dialog
 * without needing to reconnect to the server. This avoids the ~3s connect
 * latency every time the user opens the tools panel.
 *
 * Note: This was originally part of migration 015 but needs a separate
 * migration for databases that already ran 015 before this table was added.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const mcpServerTools017 = {
  version: 17,
  name: 'mcp_server_tools',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_server_tools (
        server_id     TEXT NOT NULL REFERENCES mcp_server_configs(id) ON DELETE CASCADE,
        tool_name     TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (server_id, tool_name)
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_server_tools_server
        ON mcp_server_tools(server_id);
    `);
  },
};
