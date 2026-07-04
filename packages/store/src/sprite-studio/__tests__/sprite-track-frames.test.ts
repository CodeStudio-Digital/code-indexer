/**
 * Multi-track store behavior: replaceTrackFrames only touches its track
 * (sparse indices honored); replaceFrames (legacy wrapper) rewrites the BASE
 * track dense 0..n-1 and PRESERVES overlays; deleteTrackFrames drops one
 * track; track-settings helpers normalize/cap/remove.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { spriteStudio196 } from '../../migrations/196_sprite_studio.js';
import { spriteFrameTracks199 } from '../../migrations/199_sprite_frame_tracks.js';
import { SpriteAnimationsStore } from '../sprite-animations-store.js';
import { addTrack, normalizeTracks, patchTrack, removeTrack, MAX_TRACKS } from '../track-settings.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let store: SpriteAnimationsStore;
let animId: number;

beforeEach(() => {
  db = new Database(':memory:');
  spriteStudio196.up(db);
  spriteFrameTracks199.up(db);
  store = new SpriteAnimationsStore(db);
  db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'game')`).run();
  db.prepare(`INSERT INTO sprite_assets (sprite_project_id, slug, display_name) VALUES (1, 'hero', 'Hero')`).run();
  animId = Number(db.prepare(`INSERT INTO sprite_animations (asset_id, name) VALUES (1, 'walk')`).run().lastInsertRowid);
});

afterEach(() => db.close());

describe('replaceTrackFrames', () => {
  it('sparse overlay edits never touch other tracks', () => {
    store.replaceFrames(animId, [
      { frame_index: 0, version_id: 10 },
      { frame_index: 1, version_id: 11 },
    ]);
    store.replaceTrackFrames(animId, 1, [{ frame_index: 1, version_id: 20 }]); // sparse: col 0 empty
    const all = store.listFrames(animId);
    expect(all).toHaveLength(3);
    expect(store.listFrames(animId, 0).map((f) => f.version_id)).toEqual([10, 11]);
    expect(store.listFrames(animId, 1).map((f) => [f.frame_index, f.version_id])).toEqual([[1, 20]]);
  });

  it('legacy replaceFrames rewrites base dense and PRESERVES overlays', () => {
    store.replaceTrackFrames(animId, 1, [{ frame_index: 2, version_id: 99 }]);
    store.replaceFrames(animId, [
      { frame_index: 5, version_id: 30 }, // input order wins → reindexed 0..1
      { frame_index: 9, version_id: 31 },
    ]);
    expect(store.listFrames(animId, 0).map((f) => [f.frame_index, f.version_id])).toEqual([[0, 30], [1, 31]]);
    expect(store.listFrames(animId, 1)).toHaveLength(1); // overlay survived regen
  });

  it('deleteTrackFrames drops exactly one track', () => {
    store.replaceFrames(animId, [{ frame_index: 0, version_id: 10 }]);
    store.replaceTrackFrames(animId, 2, [{ frame_index: 0, version_id: 40 }]);
    store.deleteTrackFrames(animId, 2);
    expect(store.listFrames(animId)).toHaveLength(1);
    expect(store.listFrames(animId)[0].track).toBe(0);
  });
});

describe('track-settings', () => {
  it('normalizeTracks always injects Base and sorts by id', () => {
    expect(normalizeTracks({})).toEqual([{ id: 0, name: 'Base', visible: true }]);
    const t = normalizeTracks({ tracks: [{ id: 2, name: 'FX', visible: false }] });
    expect(t.map((x) => x.id)).toEqual([0, 2]);
    expect(t[1]).toMatchObject({ name: 'FX', visible: false });
  });

  it('addTrack caps at MAX_TRACKS and ids are max+1', () => {
    let settings: Record<string, unknown> = {};
    const ids: number[] = [];
    for (;;) {
      const r = addTrack(settings, undefined);
      if (!r) break;
      ids.push(r.newId);
      settings = { tracks: r.tracks };
    }
    expect(ids).toEqual([1, 2, 3]); // Base + 3 = MAX_TRACKS(4)
    expect(normalizeTracks(settings)).toHaveLength(MAX_TRACKS);
  });

  it('patchTrack renames/toggles; removeTrack refuses track 0', () => {
    const settings = { tracks: [{ id: 1, name: 'FX', visible: true }] };
    expect(patchTrack(settings, 1, { visible: false })?.find((t) => t.id === 1)?.visible).toBe(false);
    expect(patchTrack(settings, 9, {})).toBeNull();
    expect(removeTrack(settings, 0)).toBeNull();
    expect(removeTrack(settings, 1)?.map((t) => t.id)).toEqual([0]);
  });
});
