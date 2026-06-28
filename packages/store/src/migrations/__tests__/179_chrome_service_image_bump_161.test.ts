/**
 * Migration 179 — chrome_service_image_bump_161.
 *
 * Pin invariants:
 *   - On a PROJECT DB (chrome_service_configs trimmed away — it is in
 *     CENTRAL_DROP_TABLES) up() is a no-op, NOT a crash. Without the table guard
 *     the prepared UPDATE threw `no such table: chrome_service_configs` and
 *     aborted project-DB init on upgrade.
 *   - On a CENTRAL DB it upgrades the known-old default image and leaves a
 *     customised image untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { chromeServiceImageBump161_179 } from '../179_chrome_service_image_bump_161.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

const OLD_IMAGE = 'mcr.microsoft.com/playwright:v1.60.0-jammy';
const NEW_IMAGE = 'mcr.microsoft.com/playwright:v1.61.1-jammy';

function createConfigTable(image: string): void {
  db.exec(`CREATE TABLE chrome_service_configs (id INTEGER PRIMARY KEY, image TEXT, updated_at TEXT)`);
  db.prepare(`INSERT INTO chrome_service_configs (id, image, updated_at) VALUES (1, ?, '')`).run(image);
}

function imageOf(): string | undefined {
  return (db.prepare(`SELECT image FROM chrome_service_configs WHERE id = 1`).get() as { image?: string } | undefined)
    ?.image;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
});

describe('migration 179 — chrome_service_image_bump_161', () => {
  it('no-ops when chrome_service_configs is absent (trimmed project DB)', () => {
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chrome_service_configs'`).get(),
    ).toBeUndefined();
    expect(() => chromeServiceImageBump161_179.up(db)).not.toThrow();
  });

  it('upgrades the known-old default image (central DB)', () => {
    createConfigTable(OLD_IMAGE);
    chromeServiceImageBump161_179.up(db);
    expect(imageOf()).toBe(NEW_IMAGE);
  });

  it('leaves a customised image untouched', () => {
    const custom = 'registry.internal/playwright:pinned';
    createConfigTable(custom);
    chromeServiceImageBump161_179.up(db);
    expect(imageOf()).toBe(custom);
  });
});
