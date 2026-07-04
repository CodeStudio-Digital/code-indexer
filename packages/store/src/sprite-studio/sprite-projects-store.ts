/**
 * SpriteProjectsStore — 1 sprite project per IDE project (migration 196).
 *
 * Central-DB store (jobs/costs cross into admin metering; churn is low).
 * Convention mirror of PipelineProviderBindingsStore: RawRow → mapRow with
 * JSON parsing, datetime('now') timestamps, better-sqlite3 handle injected.
 *
 * FK cascade only fires with PRAGMA foreign_keys ON, so delete() removes
 * every child-table row explicitly inside one transaction (mig 174 caveat).
 */
import type DatabaseConstructor from 'better-sqlite3';
import {
  DEFAULT_SPRITE_STYLE,
  type SpriteProjectRow,
  type SpriteStyleConfig,
} from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface RawRow {
  id: number;
  project_id: number;
  name: string;
  style_json: string;
  export_dir: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawRow): SpriteProjectRow {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    // Merge over the default so style rows written by older app versions
    // keep working when new style dimensions are added later.
    style: row.style_json
      ? { ...DEFAULT_SPRITE_STYLE, ...(JSON.parse(row.style_json) as Partial<SpriteStyleConfig>) }
      : { ...DEFAULT_SPRITE_STYLE },
    export_dir: row.export_dir,
    settings: row.settings_json ? (JSON.parse(row.settings_json) as Record<string, unknown>) : {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface SpriteProjectCreateInput {
  project_id: number;
  name: string;
  style?: SpriteStyleConfig;
  export_dir?: string;
  settings?: Record<string, unknown>;
}

export interface SpriteProjectUpdateInput {
  name?: string;
  style?: SpriteStyleConfig;
  export_dir?: string;
  settings?: Record<string, unknown>;
}

export class SpriteProjectsStore {
  constructor(private db: DB) {}

  getByProjectId(projectId: number): SpriteProjectRow | null {
    const row = this.db
      .prepare('SELECT * FROM sprite_projects WHERE project_id = ?')
      .get(projectId) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Look up a sprite project by its own DB id (jobs reference this). */
  getById(id: number): SpriteProjectRow | null {
    const row = this.db
      .prepare('SELECT * FROM sprite_projects WHERE id = ?')
      .get(id) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Insert the sprite project for an IDE project; style defaults to DEFAULT_SPRITE_STYLE. */
  create(input: SpriteProjectCreateInput): SpriteProjectRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_projects (project_id, name, style_json, export_dir, settings_json)
         VALUES (@project_id, @name, @style_json, @export_dir, @settings_json)`,
      )
      .run({
        project_id: input.project_id,
        name: input.name,
        style_json: JSON.stringify(input.style ?? DEFAULT_SPRITE_STYLE),
        export_dir: input.export_dir ?? 'assets/sprites',
        settings_json: JSON.stringify(input.settings ?? {}),
      });
    const row = this.db
      .prepare('SELECT * FROM sprite_projects WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as RawRow;
    return mapRow(row);
  }

  update(id: number, input: SpriteProjectUpdateInput): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.name !== undefined) { sets.push('name = @name'); params.name = input.name; }
    if (input.style !== undefined) { sets.push('style_json = @style_json'); params.style_json = JSON.stringify(input.style); }
    if (input.export_dir !== undefined) { sets.push('export_dir = @export_dir'); params.export_dir = input.export_dir; }
    if (input.settings !== undefined) { sets.push('settings_json = @settings_json'); params.settings_json = JSON.stringify(input.settings); }
    if (sets.length === 0) return false;
    const result = this.db
      .prepare(`UPDATE sprite_projects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`)
      .run(params);
    return Number(result.changes) > 0;
  }

  /**
   * Delete the sprite project AND all children explicitly (frames →
   * animations → versions → references → jobs → assets → project) —
   * FK cascades don't fire without PRAGMA foreign_keys.
   */
  delete(id: number): boolean {
    const txn = this.db.transaction((spriteProjectId: number) => {
      const assetIds = 'SELECT id FROM sprite_assets WHERE sprite_project_id = ?';
      this.db
        .prepare(
          `DELETE FROM sprite_frames WHERE animation_id IN (
             SELECT id FROM sprite_animations WHERE asset_id IN (${assetIds}))`,
        )
        .run(spriteProjectId);
      this.db.prepare(`DELETE FROM sprite_animations WHERE asset_id IN (${assetIds})`).run(spriteProjectId);
      this.db.prepare(`DELETE FROM sprite_asset_versions WHERE asset_id IN (${assetIds})`).run(spriteProjectId);
      this.db.prepare('DELETE FROM sprite_references WHERE sprite_project_id = ?').run(spriteProjectId);
      this.db.prepare('DELETE FROM sprite_generation_jobs WHERE sprite_project_id = ?').run(spriteProjectId);
      this.db.prepare('DELETE FROM sprite_assets WHERE sprite_project_id = ?').run(spriteProjectId);
      return this.db.prepare('DELETE FROM sprite_projects WHERE id = ?').run(spriteProjectId);
    });
    return Number(txn(id).changes) > 0;
  }
}
