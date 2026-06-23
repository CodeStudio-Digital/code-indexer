import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDriver } from '../sqlite.js';
import { createDriver } from '../factory.js';
import { DbConnectionManager } from '../manager.js';
import type { DatabaseDriver } from '../types.js';

/**
 * Exercises the SQLite driver against a real temp file: DDL, insert,
 * introspection (columns + pk + index + FK), runQuery + row cap. Uses
 * better-sqlite3 (the store's binary) — if the native ABI is stale this needs
 * `pnpm node:rebuild` with the app closed.
 */
describe('@mcp/db-drivers sqlite', () => {
  let dir: string;
  let driver: DatabaseDriver;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dbdrv-'));
    const filePath = join(dir, 'test.sqlite');
    driver = createSqliteDriver({ engine: 'sqlite', filePath });
    await driver.runQuery(
      `CREATE TABLE users (
         id INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         email TEXT
       )`,
    );
    await driver.runQuery(
      `CREATE TABLE posts (
         id INTEGER PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id),
         title TEXT
       )`,
    );
    await driver.runQuery(`CREATE UNIQUE INDEX idx_users_email ON users(email)`);
    await driver.runQuery(`INSERT INTO users (name, email) VALUES (?, ?)`, { params: ['Ada', 'ada@x.io'] });
    await driver.runQuery(`INSERT INTO users (name, email) VALUES (?, ?)`, { params: ['Linus', 'linus@x.io'] });
  });

  afterAll(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('testConnection returns a SQLite version', async () => {
    const { serverVersion } = await driver.testConnection();
    expect(serverVersion).toMatch(/SQLite/);
  });

  it('lists tables (excludes sqlite_ internal)', async () => {
    const tables = await driver.listTables();
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['posts', 'users']);
    expect(tables.every((t) => !t.name.startsWith('sqlite_'))).toBe(true);
  });

  it('describes columns with pk + auto-increment + nullability', async () => {
    const info = await driver.describeTable('main', 'users');
    const id = info.columns.find((c) => c.name === 'id')!;
    const name = info.columns.find((c) => c.name === 'name')!;
    const email = info.columns.find((c) => c.name === 'email')!;
    expect(id.isPrimaryKey).toBe(true);
    expect(id.isAutoIncrement).toBe(true);
    expect(name.nullable).toBe(false);
    expect(email.nullable).toBe(true);
    // The unique index on email is reported.
    expect(info.indexes?.some((ix) => ix.columns.includes('email') && ix.unique)).toBe(true);
  });

  it('reports foreign keys', async () => {
    const info = await driver.describeTable('main', 'posts');
    const fk = info.foreignKeys?.[0];
    expect(fk?.refTable).toBe('users');
    expect(fk?.columns).toContain('user_id');
    expect(fk?.refColumns).toContain('id');
  });

  it('runs a SELECT and returns rows + fields', async () => {
    const res = await driver.runQuery('SELECT id, name, email FROM users ORDER BY id');
    expect(res.rowCount).toBe(2);
    expect(res.fields.map((f) => f.name)).toEqual(['id', 'name', 'email']);
    expect(res.rows[0].name).toBe('Ada');
  });

  it('caps rows with maxRows and flags truncated', async () => {
    const res = await driver.runQuery('SELECT * FROM users', { maxRows: 1 });
    expect(res.rows.length).toBe(1);
    expect(res.truncated).toBe(true);
    expect(res.rowCount).toBe(2);
  });

  it('reports affected rows for a write', async () => {
    const res = await driver.runQuery(`UPDATE users SET email = 'x@y.io' WHERE name = 'Ada'`);
    expect(res.rowCount).toBe(1);
  });
});

describe('@mcp/db-drivers factory + manager', () => {
  it('factory builds a sqlite driver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbdrv-f-'));
    const d = await createDriver({ engine: 'sqlite', filePath: join(dir, 'f.sqlite') });
    expect((await d.testConnection()).serverVersion).toMatch(/SQLite/);
    await d.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('manager caches by key and closes all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbdrv-m-'));
    const mgr = new DbConnectionManager();
    const cfg = { engine: 'sqlite' as const, filePath: join(dir, 'm.sqlite') };
    const a = await mgr.acquire('conn:1', cfg, { pinned: true });
    const b = await mgr.acquire('conn:1', cfg, { pinned: true });
    expect(a).toBe(b); // same key → same driver
    expect(mgr.get('conn:1')).toBe(a);
    await mgr.closeAll();
    expect(mgr.get('conn:1')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
