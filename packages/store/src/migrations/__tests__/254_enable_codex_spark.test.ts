import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { enableCodexSpark254 } from '../254_enable_codex_spark.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => db?.close());

describe('migration 254 — enable Codex Spark', () => {
  it('is a no-op for trimmed databases without provider tables', () => {
    expect(() => enableCodexSpark254.up(db)).not.toThrow();
  });

  it('reenables only the listed Codex Spark row disabled by the old API gate', () => {
    db.exec(`
      CREATE TABLE provider_configs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
      );
      CREATE TABLE provider_models (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        source TEXT,
        visibility TEXT,
        supported_in_api INTEGER
      );
      INSERT INTO provider_configs (id, kind) VALUES
        ('codex', 'chatgpt'),
        ('openai', 'openai');
      INSERT INTO provider_models (
        provider_id, model_id, enabled, source, visibility, supported_in_api
      ) VALUES
        ('codex', 'gpt-5.3-codex-spark', 0, 'live', 'list', 0),
        ('codex', 'codex-auto-review', 0, 'live', 'hide', 1),
        ('openai', 'gpt-5.3-codex-spark', 0, 'live', 'list', 0);
    `);

    enableCodexSpark254.up(db);
    enableCodexSpark254.up(db);

    expect(db.prepare(`
      SELECT provider_id, model_id, enabled
        FROM provider_models
       ORDER BY provider_id, model_id
    `).all()).toEqual([
      { provider_id: 'codex', model_id: 'codex-auto-review', enabled: 0 },
      { provider_id: 'codex', model_id: 'gpt-5.3-codex-spark', enabled: 1 },
      { provider_id: 'openai', model_id: 'gpt-5.3-codex-spark', enabled: 0 },
    ]);
  });
});
