import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabaseForStartup } from '../database-startup.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), 'codestudio-db-startup-'));
  roots.push(root);
  return join(root, 'index.db');
}

describe('database startup worker', () => {
  it('initializes a fresh profile before plugin/settings stores and shares concurrent startup', async () => {
    const path = await databasePath();
    const first = initializeDatabaseForStartup(path);
    expect(initializeDatabaseForStartup(path)).toBe(first);
    await first;
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('session_storage_layout_version')).toEqual({ value: '1' });
      expect(db.prepare('SELECT count(*) AS count FROM installed_plugins').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  }, 30_000);

  it('preserves the legacy cutover refusal without modifying the database', async () => {
    const path = await databasePath();
    const db = new Database(path);
    db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY)');
    db.close();
    const before = await readFile(path);
    await expect(initializeDatabaseForStartup(path)).rejects.toThrow('Legacy SQLite session persistence detected');
    expect(await readFile(path)).toEqual(before);
  }, 30_000);
});
