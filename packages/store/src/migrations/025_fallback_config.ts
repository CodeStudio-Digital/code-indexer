/**
 * Migration 025 — Fallback configuration for provider/model recovery.
 *
 * Adds fallback chain support at two levels:
 * - Per-provider: fallback_provider_id links to another provider_configs row
 * - Per-session: fallback_provider/model override for session-specific fallback
 *
 * When a provider returns persistent errors (429, 5xx, timeout), the runner
 * can automatically swap to the next provider in the fallback chain.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const fallbackConfig025 = {
  version: 25,
  name: 'fallback_config',
  up(db: DB) {
    // Per-provider fallback chain — points to another provider's id
    db.exec(`
      ALTER TABLE provider_configs
        ADD COLUMN fallback_provider_id TEXT DEFAULT NULL;
    `);

    // Per-session fallback override
    db.exec(`
      ALTER TABLE coder_sessions
        ADD COLUMN fallback_provider TEXT DEFAULT NULL;
    `);
    db.exec(`
      ALTER TABLE coder_sessions
        ADD COLUMN fallback_model TEXT DEFAULT NULL;
    `);
  },
};
