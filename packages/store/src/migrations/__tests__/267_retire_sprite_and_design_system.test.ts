import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { retireSpriteAndDesignSystem267 } from '../267_retire_sprite_and_design_system.js';

describe('migration 267', () => {
  it('removes retired data while preserving unrelated projects and bindings', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE projects (id INTEGER PRIMARY KEY, builder_json TEXT);
        CREATE TABLE pipeline_provider_bindings (pipeline_name TEXT);
        CREATE TABLE app_settings (key TEXT);
        CREATE TABLE skill_definitions (id TEXT, source TEXT);
        CREATE TABLE disabled_tools_global (tool_name TEXT, tier TEXT);
        CREATE TABLE sprite_projects (id INTEGER PRIMARY KEY);
        CREATE TABLE design_system_sessions (id INTEGER PRIMARY KEY);
        CREATE TABLE verdaccio_configs (id INTEGER PRIMARY KEY);
        INSERT INTO projects VALUES
          (1, '{"kind":"ds"}'),
          (2, '{"kind":"app","designSystem":{"id":1}}'),
          (3, '{"kind":"app"}');
        INSERT INTO pipeline_provider_bindings VALUES ('sprite-studio'), ('coder');
        INSERT INTO app_settings VALUES ('SPRITE_STUDIO_ENABLED'), ('theme');
        INSERT INTO skill_definitions VALUES ('ds-ctx-ui', 'builtin'), ('web-design-guidelines', 'imported');
        INSERT INTO disabled_tools_global VALUES
          ('ds_publish', 'default'), ('sprite_export', 'default'), ('read_file', 'coder');
        INSERT INTO sprite_projects VALUES (1);
        INSERT INTO design_system_sessions VALUES (1);
        INSERT INTO verdaccio_configs VALUES (1);
      `);

      retireSpriteAndDesignSystem267.up(db);

      expect(db.prepare('SELECT id, builder_json FROM projects ORDER BY id').all()).toEqual([
        { id: 2, builder_json: '{"kind":"app"}' },
        { id: 3, builder_json: '{"kind":"app"}' },
      ]);
      expect(db.prepare('SELECT pipeline_name FROM pipeline_provider_bindings').all()).toEqual([
        { pipeline_name: 'coder' },
      ]);
      expect(db.prepare('SELECT key FROM app_settings').all()).toEqual([{ key: 'theme' }]);
      expect(db.prepare('SELECT id FROM skill_definitions').all()).toEqual([{ id: 'web-design-guidelines' }]);
      expect(db.prepare('SELECT tool_name FROM disabled_tools_global').all()).toEqual([
        { tool_name: 'read_file' },
      ]);
      for (const table of ['sprite_projects', 'design_system_sessions', 'verdaccio_configs']) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });
});
