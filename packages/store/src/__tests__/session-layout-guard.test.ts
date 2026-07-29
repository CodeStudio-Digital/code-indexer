import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LegacySessionDatabaseError,
  SESSION_STORAGE_LAYOUT_KEY,
  assertNoSessionMigrationMaintenanceLock,
  assertSessionScopedSqliteAbsent,
  assertSessionStorageLayoutReady,
  markSessionStorageLayoutReady,
  readSessionStorageLayoutVersion,
} from '../session-layout-guard.js';

describe('filesystem session layout startup guard', () => {
  let db: Database.Database | undefined;
  const cleanup: string[] = [];

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const path of cleanup.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('allows only a genuinely fresh database to bootstrap without a marker', () => {
    db = new Database(':memory:');

    expect(() =>
      assertSessionStorageLayoutReady(db!, { allowFreshBootstrap: true }),
    ).not.toThrow();
    expect(() =>
      assertSessionStorageLayoutReady(db!, { allowFreshBootstrap: false }),
    ).toThrow(LegacySessionDatabaseError);
  });

  it('writes and accepts the versioned marker used by the offline migrator', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    markSessionStorageLayoutReady(db);

    expect(readSessionStorageLayoutVersion(db)).toBe('1');
    expect(() =>
      assertSessionStorageLayoutReady(db!, { allowFreshBootstrap: false }),
    ).not.toThrow();
  });

  it('fails closed for an unknown layout marker', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run(SESSION_STORAGE_LAYOUT_KEY, '99', new Date().toISOString());

    expect(() =>
      assertSessionStorageLayoutReady(db!, { allowFreshBootstrap: false }),
    ).toThrow(/Unsupported filesystem session layout version/);
  });

  it('rejects a forbidden session table even when the layout marker is valid', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE skill_usage_log (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL
      );
    `);
    markSessionStorageLayoutReady(db);

    expect(() => assertSessionStorageLayoutReady(db!, {
      allowFreshBootstrap: false,
    })).not.toThrow();
    expect(() => assertSessionScopedSqliteAbsent(db!)).toThrow(
      /forbidden session table: skill_usage_log/,
    );
  });

  it('blocks application startup while another process owns the cutover lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-layout-lock-'));
    cleanup.push(root);
    const dbPath = join(root, 'index.db');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, '.sessions-fs-migrate.lock'),
      JSON.stringify({ pid: process.pid + 1000 }),
    );

    expect(() => assertNoSessionMigrationMaintenanceLock(dbPath)).toThrow(
      /offline cutover is active or was interrupted/,
    );
  });
});
