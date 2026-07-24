import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { retireQualityClassifiers262 } from '../262_retire_quality_classifiers.js';

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => db.close());

describe('migration 262 - retire quality classifiers', () => {
  it('drops classifier tables and removes only retired pipeline bindings', () => {
    db.exec(`
      CREATE TABLE quality_classifications (id INTEGER PRIMARY KEY);
      CREATE TABLE quality_interventions (id INTEGER PRIMARY KEY);
      CREATE TABLE pipeline_provider_bindings (
        id INTEGER PRIMARY KEY,
        pipeline_name TEXT NOT NULL
      );
      INSERT INTO pipeline_provider_bindings (id, pipeline_name) VALUES
        (1, 'quality_delivery'),
        (2, 'quality_code'),
        (3, 'doc_ingest');
    `);

    retireQualityClassifiers262.up(db);
    retireQualityClassifiers262.up(db);

    expect(db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('quality_classifications', 'quality_interventions')
    `).all()).toEqual([]);
    expect(db.prepare(`
      SELECT pipeline_name FROM pipeline_provider_bindings ORDER BY id
    `).all()).toEqual([{ pipeline_name: 'doc_ingest' }]);
  });

  it('is safe when classifier and binding tables are absent', () => {
    expect(() => retireQualityClassifiers262.up(db)).not.toThrow();
  });
});
