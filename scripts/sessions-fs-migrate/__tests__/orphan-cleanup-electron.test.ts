import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadDatabaseConstructor,
  openDatabase,
  tableColumns,
  tableExists,
} from '../db.js';
import {
  assertEssentialDigest,
  captureEssentialDigest,
  createCleanClone,
} from '../cleaner.js';
import { buildRelationalExportIndex } from '../relational.js';
import { UuidRegistry } from '../uuid-map.js';
import type { BundlePlan } from '../model.js';

const cleanup: string[] = [];
const electronDescribe = process.versions.electron ? describe : describe.skip;

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

electronDescribe('Electron-ABI orphan cleanup regressions', () => {
  it('preserves synthetic projects and their permitted index data', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-synthetic-project-'));
    cleanup.push(root);
    const sourcePath = join(root, 'source.db');
    const cleanPath = join(root, 'clean.db');
    const Database = loadDatabaseConstructor();
    const source = new Database(sourcePath);
    source.pragma('foreign_keys = ON');
    source.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        root_path TEXT NOT NULL,
        name TEXT,
        is_synthetic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL
      );
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO projects (id, root_path, name, is_synthetic) VALUES
        (1, 'D:\\real', 'real', 0),
        (95, 'D:\\synthetic', '__global_fixture', 1);
      INSERT INTO files (id, project_id, path) VALUES
        (10, 1, 'real.ts'),
        (20, 95, 'synthetic.ts');
      INSERT INTO symbols (id, project_id, file_id, name) VALUES
        (100, 1, 10, 'realSymbol'),
        (200, 95, 20, 'syntheticSymbol');
      INSERT INTO coder_sessions (id, project_id) VALUES (7, 95);
    `);
    const essential = captureEssentialDigest(source);
    source.close();

    const cleanEssential = createCleanClone(sourcePath, cleanPath, essential);

    const clean = openDatabase(cleanPath, { readonly: true, fileMustExist: true });
    try {
      expect(clean.prepare('SELECT id FROM projects ORDER BY id').all()).toEqual([
        { id: 1 },
        { id: 95 },
      ]);
      expect(clean.prepare('SELECT id, project_id, path FROM files ORDER BY id').all()).toEqual([
        { id: 10, project_id: 1, path: 'real.ts' },
        { id: 20, project_id: 95, path: 'synthetic.ts' },
      ]);
      expect(clean.prepare('SELECT id, project_id, file_id, name FROM symbols ORDER BY id').all()).toEqual([
        { id: 100, project_id: 1, file_id: 10, name: 'realSymbol' },
        { id: 200, project_id: 95, file_id: 20, name: 'syntheticSymbol' },
      ]);
      expect(clean.pragma('foreign_key_check')).toEqual([]);
      expect(tableExists(clean, 'coder_sessions')).toBe(false);
      assertEssentialDigest(cleanEssential, clean);
    } finally {
      clean.close();
    }

    const untouched = openDatabase(sourcePath, { readonly: true, fileMustExist: true });
    try {
      expect(untouched.prepare(
        'SELECT COUNT(*) AS count FROM projects WHERE is_synthetic = 1',
      ).get()).toEqual({ count: 1 });
      expect(untouched.prepare(
        'SELECT COUNT(*) AS count FROM files WHERE project_id = 95',
      ).get()).toEqual({ count: 1 });
      expect(untouched.prepare(
        'SELECT COUNT(*) AS count FROM symbols WHERE project_id = 95',
      ).get()).toEqual({ count: 1 });
    } finally {
      untouched.close();
    }
  });

  it('preserves all 517 project investigations while removing session_id from the clone', () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-fs-investigations-'));
    cleanup.push(root);
    const sourcePath = join(root, 'source.db');
    const cleanPath = join(root, 'clean.db');
    const Database = loadDatabaseConstructor();
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        root_path TEXT NOT NULL,
        name TEXT,
        is_synthetic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL
      );
      CREATE TABLE coder_investigations (
        id INTEGER PRIMARY KEY,
        project_id INTEGER,
        session_id INTEGER,
        topic TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        source_label TEXT,
        agent_type TEXT,
        tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO projects (id, root_path, name, is_synthetic)
      VALUES (1, 'D:\\fixture', 'fixture', 0);
      INSERT INTO coder_sessions (id, project_id) VALUES (7, 1);
    `);
    const insert = source.prepare(
      `INSERT INTO coder_investigations
       (id, project_id, session_id, topic, summary, body, created_at)
       VALUES (?, 1, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    );
    source.transaction(() => {
      for (let id = 1; id <= 517; id += 1) {
        insert.run(id, id % 2 === 0 ? 7 : 999, `topic-${id}`, `summary-${id}`, `body-${id}`);
      }
    })();
    const essential = captureEssentialDigest(source);
    source.close();

    createCleanClone(sourcePath, cleanPath, essential);

    const clean = openDatabase(cleanPath, { readonly: true, fileMustExist: true });
    try {
      expect(clean.prepare(
        'SELECT COUNT(*) AS count FROM coder_investigations',
      ).get()).toEqual({ count: 517 });
      expect(tableColumns(clean, 'coder_investigations')).not.toContain('session_id');
      expect(clean.prepare(
        `SELECT topic, summary, body FROM coder_investigations WHERE id = 517`,
      ).get()).toEqual({
        topic: 'topic-517',
        summary: 'summary-517',
        body: 'body-517',
      });
    } finally {
      clean.close();
    }
  });

  it('never reassigns an orphan coder row to a Company session with the same numeric ID', () => {
    const Database = loadDatabaseConstructor();
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
        CREATE TABLE company_sessions (id INTEGER PRIMARY KEY);
        CREATE TABLE session_events (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL,
          kind TEXT NOT NULL
        );
        INSERT INTO coder_sessions (id) VALUES (1);
        INSERT INTO company_sessions (id) VALUES (7);
        INSERT INTO session_events (id, session_id, kind) VALUES (1, 7, 'legacy');
      `);
      const plans: BundlePlan[] = [
        {
          identity: { kind: 'coder', id: 1 },
          uuid: '11111111-1111-4111-8111-111111111111',
          scope: 'global',
          finalDir: 'coder-final',
          stagingDir: 'coder-staging',
        },
        {
          identity: { kind: 'company', id: 7 },
          uuid: '77777777-7777-4777-8777-777777777777',
          scope: 'global',
          finalDir: 'company-final',
          stagingDir: 'company-staging',
        },
      ];
      const relational = buildRelationalExportIndex(
        db,
        plans,
        new UuidRegistry(null, 'f'.repeat(64)),
      );
      expect(relational.rowsByTable.get('session_events')).toEqual([]);
      expect(relational.orphanCleanup.session_events?.rows).toBe(1);
      expect(relational.orphanRowsByTable.get('session_events')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
