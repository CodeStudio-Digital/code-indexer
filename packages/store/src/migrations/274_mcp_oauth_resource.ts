import type { Migration } from './types.js';

/** Additive: existing registrations and tokens remain usable. */
export const mcpOAuthResource274: Migration = {
  version: 274,
  name: 'mcp_oauth_resource',
  up(db) {
    // Project databases share this migration lineage but trim global OAuth tables.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_oauth_registrations'").get()) return;
    const columns = new Set((db.prepare('PRAGMA table_info(mcp_oauth_registrations)').all() as { name: string }[]).map(column => column.name));
    if (!columns.has('resource_url')) db.exec('ALTER TABLE mcp_oauth_registrations ADD COLUMN resource_url TEXT');
    if (!columns.has('token_endpoint_auth_method')) db.exec('ALTER TABLE mcp_oauth_registrations ADD COLUMN token_endpoint_auth_method TEXT');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_server_configs'").get()) {
      db.exec(`UPDATE mcp_oauth_registrations SET resource_url =
        (SELECT url FROM mcp_server_configs WHERE id = server_id)
        WHERE resource_url IS NULL;`);
    }
  },
};
