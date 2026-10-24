/**
 * Migration 005 — Cache token columns for coder sessions and messages.
 *
 * Adds 4 columns (all default 0, additive only — no destructive changes):
 *   - coder_sessions.total_cache_read_tokens
 *   - coder_sessions.total_cache_creation_tokens
 *   - coder_messages.cache_read_tokens
 *   - coder_messages.cache_creation_tokens
 *
 * This lets the dashboard display retroactive cache hit data after the
 * monotone push-time truncation fix made server-side prompt caches actually
 * work for ZAI/GLM and Anthropic providers. Old sessions keep working with 0s.
 *
 * Uses ALTER TABLE … ADD COLUMN with try/catch so the migration is safe to
 * re-run on databases where it was already partially applied.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderCacheTokens005: Migration = {
  version: 5,
  name: 'coder_cache_tokens',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'total_cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_sessions', 'total_cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_messages', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_messages', 'cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0');
  },
};
