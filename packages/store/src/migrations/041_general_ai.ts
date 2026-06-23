/**
 * Migration 041 — "General AI" model selection.
 *
 * Introduces the concept of a utility/assistant AI model, distinct from the
 * coder/agent models. First consumer is the dashboard Git panel's
 * "generate commit message" button; future consumers (text/prompt generation,
 * small structured tasks) will reuse the same setting.
 *
 * Schema additions:
 *   - `provider_configs.use_for_general` — boolean flag mirroring
 *     `use_for_agent`/`use_for_coder`. Lets operators mark which providers
 *     are eligible as the general-AI backend.
 *   - `app_settings` — tiny KV table for app-global settings that don't
 *     deserve their own table. The general-AI selection lands here under
 *     key `general_default_model` as JSON `{ providerId, modelId }`.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const generalAi041 = {
  version: 41,
  name: 'general_ai',
  up(db: DB) {
    db.exec(`
      ALTER TABLE provider_configs
        ADD COLUMN use_for_general INTEGER NOT NULL DEFAULT 0;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
