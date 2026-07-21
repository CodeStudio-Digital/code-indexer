import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { kimiCodeApiKeyOnly243 } from '../243_kimi_code_api_key_only.js';

describe('migration 243 — Kimi Code API key only', () => {
  it('removes OAuth credentials while preserving explicit API keys', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        api_key TEXT,
        auth_mode TEXT,
        extra TEXT
      );
      CREATE TABLE oauth_tokens (
        provider_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL
      );
      INSERT INTO provider_configs VALUES
        ('kimi-oauth', 'kimi-code', 'oauth-access', 'oauth',
         '{"oauth_key":"oauth/kimi-code","device_id":"dev","thinkingMode":"auto"}'),
        ('kimi-api', 'kimi-code', 'user-api-key', 'api_key',
         '{"oauth_host":"https://auth.kimi.com","thinkingMode":"enabled"}'),
        ('copilot', 'copilot', 'copilot-access', 'oauth', '{}');
      INSERT INTO oauth_tokens VALUES
        ('kimi-oauth', 'oauth-access'),
        ('kimi-api', 'stale-oauth-access'),
        ('copilot', 'copilot-access');
    `);

    kimiCodeApiKeyOnly243.up(db);

    expect(db.prepare(`
      SELECT id, api_key, auth_mode, extra
        FROM provider_configs
       WHERE kind = 'kimi-code'
       ORDER BY id
    `).all()).toEqual([
      {
        id: 'kimi-api',
        api_key: 'user-api-key',
        auth_mode: 'api_key',
        extra: '{"thinkingMode":"enabled"}',
      },
      {
        id: 'kimi-oauth',
        api_key: null,
        auth_mode: 'api_key',
        extra: '{"thinkingMode":"auto"}',
      },
    ]);
    expect(db.prepare('SELECT provider_id FROM oauth_tokens ORDER BY provider_id').all())
      .toEqual([{ provider_id: 'copilot' }]);
    expect(db.prepare(`SELECT auth_mode FROM provider_configs WHERE id = 'copilot'`).get())
      .toEqual({ auth_mode: 'oauth' });
    db.close();
  });

  it('is a no-op in trimmed databases without provider tables', () => {
    const db = new Database(':memory:');
    expect(() => kimiCodeApiKeyOnly243.up(db)).not.toThrow();
    db.close();
  });
});
