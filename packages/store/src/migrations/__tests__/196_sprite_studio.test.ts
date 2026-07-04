/**
 * Migration 196 — sprite_studio.
 *
 * Pin invariants:
 *   - up() creates all seven tables (incl. the phase-2 reserved
 *     sprite_animations / sprite_frames).
 *   - Idempotent (CREATE TABLE IF NOT EXISTS).
 *   - UNIQUE keys hold: one sprite project per IDE project,
 *     (sprite_project_id, slug) per asset, (asset_id, version) per version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { spriteStudio196 } from '../196_sprite_studio.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

const TABLES = [
  'sprite_projects',
  'sprite_assets',
  'sprite_asset_versions',
  'sprite_references',
  'sprite_generation_jobs',
  'sprite_animations',
  'sprite_frames',
];

function tableNames(): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((t) => t.name);
}

beforeEach(() => {
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
});

describe('migration 196 — sprite_studio', () => {
  it('creates all sprite studio tables', () => {
    spriteStudio196.up(db);
    const names = tableNames();
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('is idempotent — a second up() run is a no-op', () => {
    spriteStudio196.up(db);
    expect(() => spriteStudio196.up(db)).not.toThrow();
  });

  it('enforces the UNIQUE keys', () => {
    spriteStudio196.up(db);
    db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'game')`).run();
    expect(() =>
      db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'dup')`).run(),
    ).toThrow();

    db.prepare(`INSERT INTO sprite_assets (sprite_project_id, slug, display_name) VALUES (1, 'goblin', 'Goblin')`).run();
    expect(() =>
      db.prepare(`INSERT INTO sprite_assets (sprite_project_id, slug, display_name) VALUES (1, 'goblin', 'Dup')`).run(),
    ).toThrow();

    db.prepare(
      `INSERT INTO sprite_asset_versions (asset_id, version, file_rel_path) VALUES (1, 1, 'assets/goblin/v001.png')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO sprite_asset_versions (asset_id, version, file_rel_path) VALUES (1, 1, 'assets/goblin/v001b.png')`,
      ).run(),
    ).toThrow();
  });

  it('defaults land: asset draft/misc, job queued, animation 8fps loop', () => {
    spriteStudio196.up(db);
    db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'game')`).run();
    db.prepare(`INSERT INTO sprite_assets (sprite_project_id, slug, display_name) VALUES (1, 'goblin', 'Goblin')`).run();
    const asset = db.prepare('SELECT * FROM sprite_assets WHERE id = 1').get() as { status: string; category: string };
    expect(asset.status).toBe('draft');
    expect(asset.category).toBe('misc');

    db.prepare(`INSERT INTO sprite_generation_jobs (sprite_project_id, kind) VALUES (1, 'generate')`).run();
    const job = db.prepare('SELECT * FROM sprite_generation_jobs WHERE id = 1').get() as { status: string };
    expect(job.status).toBe('queued');

    db.prepare(`INSERT INTO sprite_animations (asset_id, name) VALUES (1, 'walk_S')`).run();
    const anim = db.prepare('SELECT * FROM sprite_animations WHERE id = 1').get() as { fps: number; loop_mode: string };
    expect(anim.fps).toBe(8);
    expect(anim.loop_mode).toBe('loop');
  });
});
