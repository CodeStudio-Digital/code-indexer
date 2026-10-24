/**
 * Migration 029 — OAuth 2.1 Authorization Server state.
 *
 * Separate from `oauth_tokens` (migration 006), which stores OUTBOUND
 * credentials (our app calling Google/OpenAI). These tables make the
 * app itself an Authorization Server for INBOUND MCP clients per the
 * 2025-03-26 MCP Authorization spec.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const oauthServer029: Migration = {
  version: 29,
  name: 'oauth_server',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id                    TEXT PRIMARY KEY,
        client_secret_hash           TEXT,
        client_name                  TEXT NOT NULL,
        redirect_uris                TEXT NOT NULL,
        grant_types                  TEXT NOT NULL,
        scopes                       TEXT NOT NULL,
        token_endpoint_auth_method   TEXT NOT NULL,
        created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at                   TEXT
      );

      CREATE TABLE IF NOT EXISTS oauth_auth_codes (
        code                   TEXT PRIMARY KEY,
        client_id              TEXT NOT NULL,
        redirect_uri           TEXT NOT NULL,
        scopes                 TEXT NOT NULL,
        code_challenge         TEXT NOT NULL,
        code_challenge_method  TEXT NOT NULL,
        expires_at             INTEGER NOT NULL,
        consumed_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON oauth_auth_codes(expires_at);

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash  TEXT PRIMARY KEY,
        client_id   TEXT NOT NULL,
        scopes      TEXT NOT NULL,
        expires_at  INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        rotated_to  TEXT,
        revoked_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        principal   TEXT,
        token_type  TEXT,
        event       TEXT NOT NULL,
        status      INTEGER NOT NULL,
        tool_name   TEXT,
        meta        TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON auth_audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_principal ON auth_audit_log(principal);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON auth_audit_log(event);
    `);
  },
};
