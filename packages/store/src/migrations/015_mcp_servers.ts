/**
 * Migration 015 — External MCP server configurations.
 *
 * Stores connection details for external MCP servers (GitHub, Linear, etc.)
 * that the Coder Agent can connect to at session start. Each server exposes
 * tools that are prefixed with `ext_<server_id>__` and integrated into the
 * tool registry alongside the internal indexer tools.
 *
 * Supports three transports: stdio, sse, streamable_http.
 * Auth Phase 1: none, api_key, bearer.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const mcpServers015 = {
  version: 15,
  name: 'mcp_servers',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_server_configs (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        transport     TEXT NOT NULL DEFAULT 'stdio',
        enabled       INTEGER NOT NULL DEFAULT 1,
        url           TEXT,
        command       TEXT,
        args          TEXT,
        env           TEXT,
        auth_type     TEXT NOT NULL DEFAULT 'none',
        auth_token    TEXT,
        default_tier  TEXT NOT NULL DEFAULT 'navigate',
        config        TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Cached tool list per server. Populated on test/connect, read by
      -- admin panels and session tools dialog without needing to reconnect.
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
