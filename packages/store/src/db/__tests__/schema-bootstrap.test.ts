import { afterEach, expect, it, vi } from 'vitest';
import { Database, type DB } from '../types.js';
import { initSchema } from '../schema/index.js';

const opened: DB[] = [];
function open() { const db = new Database(':memory:'); opened.push(db); return db; }
afterEach(() => { vi.restoreAllMocks(); for (const db of opened.splice(0)) db.close(); });

it('rolls back a failed schema bootstrap without altering preexisting data', () => {
  const db = open();
  db.exec('CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES (\'keep\')');
  const exec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation(sql => {
    if (sql.includes('CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts')) throw new Error('fixture disk failure');
    return exec(sql);
  });
  expect(() => initSchema(db)).toThrow('fixture disk failure');
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'projects'").get()).toBeUndefined();
  expect(db.prepare('SELECT value FROM preserved').get()).toEqual({ value: 'keep' });
  expect(db.inTransaction).toBe(false);
  vi.restoreAllMocks();
  initSchema(db);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'projects'").get()).toBeTruthy();
});

it('remains idempotent and preserves search triggers and existing rows', () => {
  const db = open(); initSchema(db);
  db.prepare("INSERT INTO projects(id, name, root_path) VALUES (1, 'fixture', '/fixture')").run();
  db.prepare("INSERT INTO snapshots(project_id, title, content, tags) VALUES (1, 'needle', 'original', '[]')").run();
  const before = db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
  initSchema(db);
  expect(db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(before);
  expect(db.prepare("SELECT title FROM snapshots_fts WHERE snapshots_fts MATCH 'needle'").all()).toEqual([{ title: 'needle' }]);
});

it('composes with an outer transaction without committing its data', () => {
  const db = open();
  expect(() => db.transaction(() => { initSchema(db); throw new Error('outer rollback'); })()).toThrow('outer rollback');
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([]);
});
