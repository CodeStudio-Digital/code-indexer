import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { verifyDiscoveredBundles } from '../run.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('verify-only project roots', () => {
  it('ignores catalog rows without a usable root exactly like SessionLocator', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-verify-roots-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'sessions', 'global'), { recursive: true });
    const db = openDatabase(join(root, 'index.db'), { fileMustExist: false });
    try {
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO projects (id, root_path, is_synthetic) VALUES
          (1, '', 0),
          (2, '   ', 0),
          (3, 'synthetic-without-root', 1);
      `);
      expect(verifyDiscoveredBundles(db, dataDir)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('still fails closed when a configured real project root is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-verify-missing-root-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'sessions', 'global'), { recursive: true });
    const missing = join(root, 'missing-project');
    const db = openDatabase(join(root, 'index.db'), { fileMustExist: false });
    try {
      db.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          root_path TEXT NOT NULL,
          is_synthetic INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.prepare(
        'INSERT INTO projects (id, root_path, is_synthetic) VALUES (1, ?, 0)',
      ).run(missing);
      expect(() => verifyDiscoveredBundles(db, dataDir))
        .toThrow(`session storage root is absent: ${missing}`);
    } finally {
      db.close();
    }
  });
});
