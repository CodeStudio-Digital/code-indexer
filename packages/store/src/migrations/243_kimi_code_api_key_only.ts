/** Migration 243 — remove Kimi Code OAuth credentials and require API keys. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

export const kimiCodeApiKeyOnly243: Migration = {
  version: 243,
  name: 'kimi_code_api_key_only',
  up(db: DB): void {
    if (!hasTable(db, 'provider_configs')) return;

    db.prepare(`
      UPDATE provider_configs
         SET api_key = CASE
               WHEN lower(coalesce(auth_mode, '')) = 'oauth' THEN NULL
               ELSE api_key
             END,
             auth_mode = 'api_key',
             extra = CASE
               WHEN json_valid(coalesce(extra, '')) THEN json_remove(
                 extra,
                 '$.client_id',
                 '$.device_id',
                 '$.expires_in',
                 '$.oauth_host',
                 '$.oauth_key',
                 '$.scope',
                 '$.token_type'
               )
               ELSE extra
             END
       WHERE lower(kind) = 'kimi-code'
    `).run();

    if (hasTable(db, 'oauth_tokens')) {
      db.prepare(`
        DELETE FROM oauth_tokens
         WHERE provider_id IN (
           SELECT id FROM provider_configs WHERE lower(kind) = 'kimi-code'
         )
      `).run();
    }
  },
};
