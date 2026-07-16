import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { structuralLastChecked231 } from '../231_structural_last_checked.js';

describe('migration 231 — structural last checked', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, updated_at TEXT)`);
  });

  afterEach(() => db.close());

  it('adds the independent no-op reconciliation timestamp idempotently', () => {
    structuralLastChecked231.up(db);
    structuralLastChecked231.up(db);
    const columns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === 'structural_last_checked_at')).toHaveLength(1);
  });
});
