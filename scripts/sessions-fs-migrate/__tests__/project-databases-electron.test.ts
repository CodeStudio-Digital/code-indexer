import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDatabaseConstructor } from '../db.js';
import {
  auditProjectDatabases,
  prepareCleanProjectDatabases,
  verifyProjectDatabasesClean,
} from '../project-databases.js';

const roots: string[] = [];
const electronDescribe = process.versions.electron ? describe : describe.skip;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(): {
  root: string;
  centralPath: string;
  projectPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sessions-fs-project-db-'));
  roots.push(root);
  const centralPath = join(root, 'central.db');
  const projectPath = join(root, 'project', '.mcp-indexer', 'index.db');
  mkdirSync(join(root, 'project', '.mcp-indexer'), { recursive: true });
  const Database = loadDatabaseConstructor();
  for (const path of [centralPath, projectPath]) {
    const db = new Database(path);
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        root_path TEXT NOT NULL,
        builder_json TEXT,
        is_synthetic INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE design_system_sessions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE design_system_versions (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE design_system_components (
        id INTEGER PRIMARY KEY,
        version_id INTEGER NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE builder_checkpoints (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        session_id INTEGER,
        payload_json TEXT NOT NULL
      );
      INSERT INTO projects VALUES (1, '${join(root, 'project').replace(/'/g, "''")}', '{}', 0);
      INSERT INTO design_system_sessions VALUES (41, 1, 'running');
      INSERT INTO design_system_versions VALUES (52, 41, 'published');
      INSERT INTO design_system_components VALUES (63, 52, 'Button');
      INSERT INTO builder_checkpoints VALUES (74, 1, 41, '{"ok":true}');
    `);
    db.close();
  }
  return { root, centralPath, projectPath };
}

electronDescribe('per-project SQLite cutover', () => {
  it('proves local session rows mirror central, then cleans only the clone', () => {
    const { centralPath, projectPath } = createFixture();
    const Database = loadDatabaseConstructor();
    const central = new Database(centralPath);
    try {
      const audits = auditProjectDatabases(
        central,
        [{ projectId: 1, path: projectPath }],
        { checkpoint: true },
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        needsCleanup: true,
        sessionRows: {
          design_system_sessions: 1,
          design_system_versions: 1,
          design_system_components: 1,
          builder_checkpoints: 1,
        },
      });

      const prepared = prepareCleanProjectDatabases(
        audits,
        new Map(),
        'a'.repeat(64),
      );
      expect(prepared).toHaveLength(1);
      expect(verifyProjectDatabasesClean([
        { projectId: 1, path: prepared[0].cleanPath },
      ])).toBe(1);

      const original = new Database(projectPath, { readonly: true });
      try {
        expect(
          original.prepare('SELECT COUNT(*) AS count FROM design_system_sessions').get(),
        ).toEqual({ count: 1 });
        expect(
          original.prepare('SELECT COUNT(*) AS count FROM builder_checkpoints').get(),
        ).toEqual({ count: 1 });
      } finally {
        original.close();
      }
    } finally {
      central.close();
    }
  });

  it('fails closed when a project session row diverges from central', () => {
    const { centralPath, projectPath } = createFixture();
    const Database = loadDatabaseConstructor();
    const local = new Database(projectPath);
    local.prepare(
      `UPDATE design_system_components SET name = 'Divergent' WHERE id = 63`,
    ).run();
    local.close();

    const central = new Database(centralPath);
    try {
      expect(() => auditProjectDatabases(
        central,
        [{ projectId: 1, path: projectPath }],
        { checkpoint: true },
      )).toThrow('divergent session state');
    } finally {
      central.close();
    }
  });

  it('treats a legacy project table without is_synthetic as having no synthetic rows', () => {
    const { centralPath, projectPath } = createFixture();
    const Database = loadDatabaseConstructor();
    const local = new Database(projectPath);
    local.exec('ALTER TABLE projects DROP COLUMN is_synthetic');
    local.close();

    const central = new Database(centralPath);
    try {
      const audits = auditProjectDatabases(
        central,
        [{ projectId: 1, path: projectPath }],
        { checkpoint: true },
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].sessionRows.projects).toBeUndefined();

      const prepared = prepareCleanProjectDatabases(
        audits,
        new Map(),
        'b'.repeat(64),
      );
      expect(prepared).toHaveLength(1);
      expect(verifyProjectDatabasesClean([
        { projectId: 1, path: prepared[0].cleanPath },
      ])).toBe(1);

      const clean = new Database(prepared[0].cleanPath, { readonly: true });
      try {
        const columns = clean.prepare('PRAGMA table_info(projects)').all() as Array<{
          name: string;
        }>;
        expect(columns.map((column) => column.name)).not.toContain('is_synthetic');
        expect(
          clean.prepare('SELECT COUNT(*) AS count FROM projects').get(),
        ).toEqual({ count: 1 });
      } finally {
        clean.close();
      }
    } finally {
      central.close();
    }
  });
});
