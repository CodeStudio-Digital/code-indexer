import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeIndexDB } from '../../db.js';
import {
  assertSessionScopedSqliteAbsent,
  SESSION_STORAGE_LAYOUT_KEY,
  SESSION_STORAGE_LAYOUT_VERSION,
} from '../../session-layout-guard.js';
import { filesystemSessionCutover263 } from '../263_filesystem_session_cutover.js';

describe('migration 263 filesystem session cutover', () => {
  const handles: Array<{ close(): void }> = [];
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.close();
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a fresh application database with no session schema', () => {
    const appDb = new CodeIndexDB(':memory:');
    handles.push(appDb);
    const db = appDb.raw();

    expect(
      (
        db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
          version: number;
        }
      ).version,
    ).toBe(267);
    expect(
      (
        db.prepare('SELECT value FROM app_settings WHERE key = ?').get(
          SESSION_STORAGE_LAYOUT_KEY,
        ) as { value: string }
      ).value,
    ).toBe(SESSION_STORAGE_LAYOUT_VERSION);
    expect(
      db.prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coder_sessions'`,
      ).get(),
    ).toBeUndefined();
    expect(() => assertSessionScopedSqliteAbsent(db)).not.toThrow();

    expect(() =>
      db.prepare(
        `INSERT INTO projects (name, root_path, is_synthetic)
         VALUES ('global-workspace-catalog', 'D:/global-workspace', 1)`,
      ).run(),
    ).not.toThrow();
  });

  it('does not recreate removed session schema on the second application open', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-cutover-'));
    temporaryRoots.push(root);
    const path = join(root, 'index.db');
    const first = new CodeIndexDB(path);
    first.close();

    const reopened = new CodeIndexDB(path);
    handles.push(reopened);
    expect(() => assertSessionScopedSqliteAbsent(reopened.raw())).not.toThrow();
    expect(
      reopened.raw().prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coder_sessions'`,
      ).get(),
    ).toBeUndefined();
  });

  it('refuses to erase a populated legacy database without the offline exporter', () => {
    const db = new Database(':memory:');
    handles.push(db);
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        title TEXT
      );
      INSERT INTO coder_sessions (id, title) VALUES (42, 'must survive');
    `);

    expect(() => filesystemSessionCutover263.up(db)).toThrow(
      /Refusing to remove populated legacy session storage/,
    );
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM coder_sessions').get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(
      db.prepare('SELECT value FROM app_settings WHERE key = ?').get(
        SESSION_STORAGE_LAYOUT_KEY,
      ),
    ).toBeUndefined();
  });

  it('idempotently finalizes an already-empty clean clone', () => {
    const db = new Database(':memory:');
    handles.push(db);
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT,
        root_path TEXT,
        is_synthetic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE pipeline_provider_bindings (
        id INTEGER PRIMARY KEY,
        scope_type TEXT NOT NULL
      );
      CREATE TABLE company_drive_files (
        id INTEGER PRIMARY KEY,
        scope_key TEXT NOT NULL
      );
    `);

    expect(() => filesystemSessionCutover263.up(db)).not.toThrow();
    expect(() => filesystemSessionCutover263.up(db)).not.toThrow();
    expect(
      db.prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coder_sessions'`,
      ).get(),
    ).toBeUndefined();
    expect(() => assertSessionScopedSqliteAbsent(db)).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO pipeline_provider_bindings (id, scope_type)
         VALUES (1, 'session')`,
      ).run(),
    ).toThrow(/filesystem bundles/);
    expect(() =>
      db.prepare(
        `INSERT INTO company_drive_files (id, scope_key)
         VALUES (1, 'ses:legacy')`,
      ).run(),
    ).toThrow(/filesystem bundles/);
  });

  it('cleans a project database without requiring the central layout marker table', () => {
    const db = new Database(':memory:');
    handles.push(db);
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL
      );
      INSERT INTO files (id, path) VALUES (1, 'src/index.ts');
    `);

    expect(() => filesystemSessionCutover263.up(db)).not.toThrow();
    expect(
      db.prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'table' AND name = 'coder_sessions'`,
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT path FROM files WHERE id = 1').get(),
    ).toEqual({ path: 'src/index.ts' });
    expect(() => assertSessionScopedSqliteAbsent(db)).not.toThrow();
  });
});
