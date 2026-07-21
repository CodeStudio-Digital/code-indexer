/** Migration 242 — repair legacy Kimi Code rows routed through generic OpenAI. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

export const repairLegacyKimiCodeProvider242: Migration = {
  version: 242,
  name: 'repair_legacy_kimi_code_provider',
  up(db: DB): void {
    if (!hasTable(db, 'provider_configs')) return;

    const canonical = db.prepare(`
      SELECT 1
        FROM provider_configs
       WHERE id = 'kimi-code'
         AND lower(kind) IN ('openai', 'kimi-code')
         AND (
           lower(rtrim(coalesce(base_url, ''), '/')) = 'https://api.kimi.com/coding/v1'
           OR coalesce(extra, '') LIKE '%"oauth_key":"oauth/kimi-code"%'
         )
    `).get();
    if (!canonical) return;

    db.prepare(`
      UPDATE provider_configs
         SET kind = 'kimi-code'
       WHERE id = 'kimi-code'
         AND lower(kind) = 'openai'
    `).run();

    if (!hasTable(db, 'provider_models')) return;
    db.prepare(`
      UPDATE provider_models
         SET can_reason = 1,
             supported_reasoning_levels = '["low","high","max"]',
             default_reasoning_level = coalesce(default_reasoning_level, 'max')
       WHERE provider_id = 'kimi-code'
         AND lower(model_id) = 'k3'
    `).run();
  },
};
