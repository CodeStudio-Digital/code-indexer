/**
 * Migration 051 — Design System MCP install tracking.
 *
 * Adds `mcp_server_config_id` to `design_system_sessions` so we can track
 * which mcp_server_configs entry is currently installed for a given DS session.
 * Nullable — NULL means "not yet installed".
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const designSystemMcpInstall051 = {
  version: 51,
  name: 'design_system_mcp_install',
  up(db: DB) {
    db.exec(`
      ALTER TABLE design_system_sessions
        ADD COLUMN mcp_server_config_id TEXT
        REFERENCES mcp_server_configs(id) ON DELETE SET NULL;
    `);
  },
};
