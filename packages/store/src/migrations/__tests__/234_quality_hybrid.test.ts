import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qualityHybrid234 } from '../234_quality_hybrid.js';

describe('migration 234 — hybrid Quality', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => db.close());

  it('marks existing rows as legacy and copies the completeness binding once', () => {
    db.exec(`
      CREATE TABLE quality_classifications (
        id INTEGER PRIMARY KEY,
        classifier_name TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO quality_classifications (classifier_name, verdict) VALUES ('off_topic', 'ok');
      CREATE TABLE pipeline_provider_bindings (
        id INTEGER PRIMARY KEY,
        pipeline_name TEXT NOT NULL,
        binding_role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_mode TEXT NOT NULL,
        config_json TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id INTEGER,
        enabled INTEGER NOT NULL,
        priority INTEGER NOT NULL
      );
      INSERT INTO pipeline_provider_bindings
        (pipeline_name, binding_role, provider_id, model_id, model_mode, config_json, scope_type, scope_id, enabled, priority)
      VALUES ('quality_completeness', 'classifier', 'p1', 'm1', 'chat', '{}', 'global', NULL, 1, 10);
    `);

    qualityHybrid234.up(db);
    qualityHybrid234.up(db);

    expect(db.prepare(`SELECT scope, source, action_taken FROM quality_classifications`).get())
      .toEqual({ scope: 'legacy_turn', source: 'legacy_llm', action_taken: 'none' });
    expect(db.prepare(`SELECT pipeline_name, provider_id, model_id FROM pipeline_provider_bindings WHERE pipeline_name='quality_delivery'`).all())
      .toEqual([{ pipeline_name: 'quality_delivery', provider_id: 'p1', model_id: 'm1' }]);
  });

  it('is a safe no-op for a trimmed project database without central tables', () => {
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
    expect(() => qualityHybrid234.up(db)).not.toThrow();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='quality_classifications'`).get()).toBeUndefined();
  });
});
