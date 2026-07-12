/**
 * SpriteAssetsStore curation paths that back the Frames browser:
 *   - listVersionGroups: groups versions by generation batch (job_id), with a
 *     synthetic 'loose' bucket for job_id-less rows; versionIds are version-asc.
 *   - deleteVersions: batch delete reporting missing ids + the per-animation
 *     frame tally, and recomputing the asset's current pointer once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { spriteStudio196 } from '../../migrations/196_sprite_studio.js';
import { spriteFrameTracks199 } from '../../migrations/199_sprite_frame_tracks.js';
import { SpriteAssetsStore } from '../sprite-assets-store.js';
import { SpriteAnimationsStore } from '../sprite-animations-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let assets: SpriteAssetsStore;
let anims: SpriteAnimationsStore;

beforeEach(() => {
  db = new Database(':memory:');
  spriteStudio196.up(db);
  spriteFrameTracks199.up(db);
  assets = new SpriteAssetsStore(db);
  anims = new SpriteAnimationsStore(db);
  db.prepare(`INSERT INTO sprite_projects (project_id, name) VALUES (1, 'game')`).run();
});

afterEach(() => db.close());

function seed() {
  const asset = assets.create({ sprite_project_id: 1, slug: 'hero', display_name: 'Hero' });
  // v1,v2 from job 100 · v3 from job 101 · v4 hand-edited (no job).
  const v1 = assets.insertVersion({ asset_id: asset.id, file_rel_path: 'assets/hero/v001.png', source: 'generated', job_id: 100 });
  const v2 = assets.insertVersion({ asset_id: asset.id, file_rel_path: 'assets/hero/v002.png', source: 'generated', job_id: 100 });
  const v3 = assets.insertVersion({ asset_id: asset.id, file_rel_path: 'assets/hero/v003.png', source: 'generated', job_id: 101 });
  const v4 = assets.insertVersion({ asset_id: asset.id, file_rel_path: 'assets/hero/v004.png', source: 'edited' });
  return { asset, v1, v2, v3, v4 };
}

describe('listVersionGroups', () => {
  it('groups by job_id with a loose bucket, versionIds ascending', () => {
    const { asset, v1, v2, v3, v4 } = seed();
    const groups = assets.listVersionGroups(asset.id);
    const byJob = (j: number | null) => groups.find((g) => g.jobId === j);
    expect(groups).toHaveLength(3);
    expect(byJob(100)?.versionIds).toEqual([v1.id, v2.id]);
    expect(byJob(101)?.versionIds).toEqual([v3.id]);
    expect(byJob(null)?.versionIds).toEqual([v4.id]);
  });
});

describe('deleteVersions', () => {
  it('deletes many, reports missing, tallies frames per animation, recomputes current', () => {
    const { asset, v1, v2, v3, v4 } = seed();
    assets.setCurrentVersion(asset.id, v3.id);
    const anim = anims.create({ asset_id: asset.id, name: 'walk' });
    anims.replaceFrames(anim.id, [
      { frame_index: 0, version_id: v1.id },
      { frame_index: 1, version_id: v2.id },
      { frame_index: 2, version_id: v3.id },
    ]);

    const res = assets.deleteVersions([v2.id, v3.id, 9999]);
    expect(res.deleted.sort()).toEqual([v2.id, v3.id].sort());
    expect(res.missing).toEqual([9999]);
    expect(res.framesByAnimation[anim.id]).toBe(2); // v2 + v3 were 2 frames

    // Current pointed at v3 (deleted) → newest remaining is v4.
    expect(assets.get(asset.id)?.current_version_id).toBe(v4.id);
    // Frame rows for deleted versions are gone; v1's frame survives.
    expect(anims.listFrames(anim.id).map((f) => f.version_id)).toEqual([v1.id]);
    expect(assets.listVersions(asset.id).map((v) => v.id).sort()).toEqual([v1.id, v4.id].sort());
  });

  it('is a no-op that reports all missing when nothing exists', () => {
    const { asset } = seed();
    const res = assets.deleteVersions([4242]);
    expect(res.deleted).toEqual([]);
    expect(res.missing).toEqual([4242]);
    expect(assets.listVersions(asset.id)).toHaveLength(4);
  });
});
