/**
 * Migration 115 — per-project memory toggle.
 *
 * Mirrors `embeddings_enabled` from migration 027. Lets a project opt out of
 * project-memory (auto-extraction + proactive retrieval) without disabling
 * snapshots entirely. Default ON for all tiers — memory is NOT Pro-gated
 * (BYOK means the embedding/LLM cost is the user's, not ours).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const memoryEnabled115: Migration = {
  version: 115,
  name: 'memory_enabled',
  up: (db: DB): void => {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'memory_enabled')) {
      db.exec(`ALTER TABLE projects ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1`);
    }
  },
};
