import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

export const retireSpriteAndDesignSystem267: Migration = {
  version: 267,
  name: 'retire_sprite_and_design_system',
  up(db: DB): void {
    if (hasTable(db, 'projects') && hasColumn(db, 'projects', 'builder_json')) {
      db.exec(`
        DELETE FROM projects
        WHERE json_valid(builder_json)
          AND json_extract(builder_json, '$.kind') = 'ds';
        UPDATE projects
        SET builder_json = json_remove(builder_json, '$.designSystem')
        WHERE json_valid(builder_json)
          AND json_type(builder_json, '$.designSystem') IS NOT NULL;
      `);
    }

    if (hasTable(db, 'pipeline_provider_bindings')) {
      db.prepare("DELETE FROM pipeline_provider_bindings WHERE pipeline_name = 'sprite-studio'").run();
    }
    if (hasTable(db, 'pipeline_telemetry')) {
      db.prepare("DELETE FROM pipeline_telemetry WHERE pipeline_name = 'sprite-studio'").run();
    }
    if (hasTable(db, 'app_settings')) {
      db.exec(`DELETE FROM app_settings WHERE key IN (
        'DESIGN_SYSTEM_ENABLED', 'SPRITE_STUDIO_ENABLED', 'MCP_VERDACCIO_STORAGE_DIR'
      )`);
    }
    if (hasTable(db, 'skill_definitions')) {
      db.prepare("DELETE FROM skill_definitions WHERE id = 'ds-ctx-ui' AND source = 'builtin'").run();
    }
    if (hasTable(db, 'disabled_tools_global')) {
      db.exec(`DELETE FROM disabled_tools_global
        WHERE tool_name LIKE 'ds\\_%' ESCAPE '\\'
           OR tool_name LIKE 'sprite\\_%' ESCAPE '\\'
           OR tier IN ('design-system-studio', 'design-system-consumer', 'sprite-studio')`);
    }

    for (const table of [
      'sprite_frames', 'sprite_animations', 'sprite_generation_jobs',
      'sprite_references', 'sprite_asset_versions', 'sprite_assets', 'sprite_projects',
      'design_system_components', 'design_system_versions', 'design_system_sessions',
      'verdaccio_configs',
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  },
};
