import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../index.js';

describe('migration 279 - symbol reference target index', () => {
  it.each(['central', 'project'] as const)('upgrades a version 278 %s database', (scope: 'central' | 'project') => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE files (id INTEGER PRIMARY KEY);
        CREATE TABLE projects (id INTEGER PRIMARY KEY);
        CREATE TABLE semantic_namespace_generations (
          namespace TEXT PRIMARY KEY, active_generation_id INTEGER, building_generation_id INTEGER
        );
        CREATE TABLE semantic_jobs (namespace TEXT NOT NULL, status TEXT NOT NULL);
        INSERT INTO projects VALUES (10), (11), (12);
        INSERT INTO semantic_namespace_generations VALUES ('code:p10', 1, NULL);
        INSERT INTO semantic_jobs VALUES ('semantic:reindex:code:p11', 'paused');
        CREATE TABLE symbols (id INTEGER PRIMARY KEY, project_id INTEGER, file_path TEXT, line INTEGER);
        CREATE TABLE symbol_references (
          id INTEGER PRIMARY KEY,
          symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
        );
        INSERT INTO symbols VALUES (1, 10, 'a.ts', 4), (2, 10, 'b.ts', 8);
        INSERT INTO symbol_references VALUES (10, 1), (20, 2), (30, NULL);
      `);
      const recordVersion = db.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)');
      for (const migration of MIGRATIONS.filter((entry) => entry.version < 279)) {
        recordVersion.run(migration.version, migration.name);
      }

      expect(runMigrations(db, { scope }).applied).toEqual([279, 280, 281, 282]);
      expect(runMigrations(db, { scope }).applied).toEqual([]);
      if (scope === 'central') {
        expect(db.prepare('SELECT semantic_index_folders AS folders FROM projects ORDER BY id').all())
          .toEqual([{ folders: '["."]' }, { folders: '["."]' }, { folders: '[]' }]);
      }
      expect(db.prepare("PRAGMA index_info('idx_symbol_refs_symbol_id')").get())
        .toMatchObject({ name: 'symbol_id' });
      expect(db.prepare("PRAGMA index_info('idx_symbols_project_file_line')").all())
        .toMatchObject([{ name: 'project_id' }, { name: 'file_path' }, { name: 'line' }]);
      const references = db.prepare('SELECT * FROM symbol_references ORDER BY id');
      expect(references.all()).toEqual([
        { id: 10, symbol_id: 1 }, { id: 20, symbol_id: 2 }, { id: 30, symbol_id: null },
      ]);

      db.prepare('DELETE FROM symbols WHERE id = 1').run();
      expect(references.all()).toEqual([
        { id: 10, symbol_id: null }, { id: 20, symbol_id: 2 }, { id: 30, symbol_id: null },
      ]);
    } finally {
      db.close();
    }
  });
});
