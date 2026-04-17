/**
 * Migration 028 — API tokens for the HTTP MCP endpoint.
 *
 * Opaque bearer tokens for server-to-server integrations. The raw token is
 * never stored: only its SHA-256 hash. The admin dashboard surfaces
 * creation (returning the raw token once), listing, and revocation.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const apiTokens028: Migration = {
  version: 28,
  name: 'api_tokens',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id            TEXT PRIMARY KEY,
        token_hash    TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        scopes        TEXT NOT NULL,
        expires_at    INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at  TEXT,
        revoked_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
    `);
  },
};
