/**
 * Migration 030 — OAuth 2.1 client state for external MCP servers.
 *
 * Three tables:
 * - mcp_oauth_registrations : per-server AS metadata + our client credentials
 * - mcp_oauth_tokens        : active access/refresh token pair per server
 * - mcp_oauth_pending       : short-lived PKCE verifier + state during authz
 *
 * Separate from migration 006's `oauth_tokens` (outbound provider creds
 * like Google/OpenAI) and migration 029's `oauth_*` tables (our INBOUND
 * Authorization Server). This one is about us being a CLIENT to a third
 * party MCP server's Authorization Server.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const mcpClientOauth030: Migration = {
  version: 30,
  name: 'mcp_client_oauth',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_registrations (
        server_id              TEXT PRIMARY KEY REFERENCES mcp_server_configs(id) ON DELETE CASCADE,
        issuer                 TEXT NOT NULL,
        authorization_endpoint TEXT NOT NULL,
        token_endpoint         TEXT NOT NULL,
        revocation_endpoint    TEXT,
        registration_source    TEXT NOT NULL,
        client_id              TEXT NOT NULL,
        client_secret          TEXT,
        client_secret_hash     TEXT,
        scopes                 TEXT NOT NULL,
        redirect_uri           TEXT NOT NULL,
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
        server_id         TEXT PRIMARY KEY REFERENCES mcp_server_configs(id) ON DELETE CASCADE,
        access_token      TEXT NOT NULL,
        access_expires_at INTEGER,
        refresh_raw       TEXT,
        refresh_hash      TEXT,
        scopes            TEXT NOT NULL,
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
        state        TEXT PRIMARY KEY,
        server_id    TEXT NOT NULL REFERENCES mcp_server_configs(id) ON DELETE CASCADE,
        verifier     TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes       TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        consumed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_pending_expires ON mcp_oauth_pending(expires_at);
    `);
  },
};
