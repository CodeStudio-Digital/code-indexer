import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { qualityProviderRequestsRepair247 } from '../247_quality_provider_requests_repair.js';
import { MIGRATIONS, runMigrations } from '../index.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function columns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 247 — Quality provider request repair', () => {
  it('repairs through the runner when 234 was already recorded without the column', () => {
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE quality_classifications (
        id INTEGER PRIMARY KEY,
        classifier_name TEXT NOT NULL,
        verdict TEXT NOT NULL
      );
    `);
    const markApplied = db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)');
    for (const migration of MIGRATIONS) {
      if (migration.version !== 247) markApplied.run(migration.version, migration.name);
    }

    const result = runMigrations(db);

    expect(result.applied).toEqual([247]);
    expect(columns('quality_classifications')).toContain('provider_requests');
    expect(db.prepare(`SELECT "notnull", dflt_value FROM pragma_table_info('quality_classifications') WHERE name='provider_requests'`).get())
      .toEqual({ notnull: 1, dflt_value: '0' });
  });

  it('is idempotent and a no-op for trimmed project databases', () => {
    expect(() => qualityProviderRequestsRepair247.up(db)).not.toThrow();
    db.exec(`CREATE TABLE quality_classifications (id INTEGER PRIMARY KEY, provider_requests INTEGER NOT NULL DEFAULT 0)`);
    qualityProviderRequestsRepair247.up(db);
    qualityProviderRequestsRepair247.up(db);
    expect(columns('quality_classifications').filter((name) => name === 'provider_requests')).toHaveLength(1);
  });
});
