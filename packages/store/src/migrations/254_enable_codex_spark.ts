/** Migration 254 — repair Spark rows disabled by the old public-API gate. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

export const enableCodexSpark254: Migration = {
  version: 254,
  name: 'enable_codex_spark',
  up(db: DB): void {
    if (!hasTable(db, 'provider_configs') || !hasTable(db, 'provider_models')) return;

    db.prepare(`
      UPDATE provider_models
         SET enabled = 1
       WHERE model_id = 'gpt-5.3-codex-spark'
         AND enabled = 0
         AND source = 'live'
         AND visibility = 'list'
         AND supported_in_api = 0
         AND EXISTS (
           SELECT 1
             FROM provider_configs
            WHERE provider_configs.id = provider_models.provider_id
              AND lower(provider_configs.kind) = 'chatgpt'
         )
    `).run();
  },
};
