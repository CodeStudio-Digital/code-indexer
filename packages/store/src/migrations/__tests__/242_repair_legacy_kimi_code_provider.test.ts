import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { repairLegacyKimiCodeProvider242 } from '../242_repair_legacy_kimi_code_provider.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db?.close());

describe('migration 242 — repair legacy Kimi Code provider', () => {
  it('is a no-op for trimmed databases without provider tables', () => {
    expect(() => repairLegacyKimiCodeProvider242.up(db)).not.toThrow();
  });

  it('repairs the provider kind and K3 metadata idempotently', () => {
    db.exec(`
      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        base_url TEXT,
        extra TEXT
      );
      CREATE TABLE provider_models (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        can_reason INTEGER NOT NULL DEFAULT 0,
        supported_reasoning_levels TEXT,
        default_reasoning_level TEXT,
        context_window INTEGER
      );
      INSERT INTO provider_configs (id, kind, base_url, extra) VALUES
        ('kimi-code', 'openai', 'https://api.kimi.com/coding/v1', '{"oauth_key":"oauth/kimi-code"}');
      INSERT INTO provider_models (
        provider_id, model_id, can_reason, supported_reasoning_levels,
        default_reasoning_level, context_window
      ) VALUES ('kimi-code', 'k3', 0, NULL, NULL, 1000000);
    `);

    repairLegacyKimiCodeProvider242.up(db);
    repairLegacyKimiCodeProvider242.up(db);

    expect(db.prepare('SELECT kind FROM provider_configs WHERE id = ?').get('kimi-code'))
      .toEqual({ kind: 'kimi-code' });
    expect(db.prepare(`
      SELECT can_reason, supported_reasoning_levels, default_reasoning_level, context_window
        FROM provider_models
       WHERE provider_id = 'kimi-code' AND model_id = 'k3'
    `).get()).toEqual({
      can_reason: 1,
      supported_reasoning_levels: '["low","high","max"]',
      default_reasoning_level: 'max',
      context_window: 1_000_000,
    });
  });

  it('does not rewrite an unrelated generic OpenAI provider', () => {
    db.exec(`
      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        base_url TEXT,
        extra TEXT
      );
      INSERT INTO provider_configs (id, kind, base_url, extra) VALUES
        ('kimi-code', 'openai', 'https://example.com/v1', '{}');
    `);

    repairLegacyKimiCodeProvider242.up(db);
    expect(db.prepare('SELECT kind FROM provider_configs WHERE id = ?').get('kimi-code'))
      .toEqual({ kind: 'openai' });
  });
});
