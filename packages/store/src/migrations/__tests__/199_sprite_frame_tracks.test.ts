/**
 * Migration 199 — sprite_frames multi-track rebuild. Pins: existing rows are
 * preserved verbatim (ids included) with track=0; idempotent; the new UNIQUE
 * accepts the same frame_index on different tracks while still rejecting a
 * duplicate within one track.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { spriteStudio196 } from '../196_sprite_studio.js';
import { spriteFrameTracks199 } from '../199_sprite_frame_tracks.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  spriteStudio196.up(db);
  db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'game')`).run();
  db.prepare(`INSERT INTO sprite_assets (sprite_project_id, slug, display_name) VALUES (1, 'hero', 'Hero')`).run();
  db.prepare(`INSERT INTO sprite_animations (asset_id, name) VALUES (1, 'walk')`).run();
  db.prepare(`INSERT INTO sprite_frames (animation_id, frame_index, version_id, duration_ms) VALUES (1, 0, 10, 125)`).run();
  db.prepare(`INSERT INTO sprite_frames (animation_id, frame_index, version_id, duration_ms) VALUES (1, 1, 11, NULL)`).run();
});

afterEach(() => db.close());

describe('migration 199 — sprite_frame_tracks', () => {
  it('preserves rows (ids included) with track=0', () => {
    spriteFrameTracks199.up(db);
    const rows = db.prepare('SELECT * FROM sprite_frames ORDER BY frame_index').all() as Array<{
      id: number; frame_index: number; version_id: number; duration_ms: number | null; track: number;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1, frame_index: 0, version_id: 10, duration_ms: 125, track: 0 });
    expect(rows[1]).toMatchObject({ id: 2, frame_index: 1, version_id: 11, duration_ms: null, track: 0 });
  });

  it('is idempotent', () => {
    spriteFrameTracks199.up(db);
    expect(() => spriteFrameTracks199.up(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sprite_frames').get()).toMatchObject({ n: 2 });
  });

  it('UNIQUE allows the same frame_index on different tracks, not within one', () => {
    spriteFrameTracks199.up(db);
    db.prepare(`INSERT INTO sprite_frames (animation_id, frame_index, version_id, track) VALUES (1, 0, 12, 1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO sprite_frames (animation_id, frame_index, version_id, track) VALUES (1, 0, 13, 1)`).run(),
    ).toThrow();
  });
});
