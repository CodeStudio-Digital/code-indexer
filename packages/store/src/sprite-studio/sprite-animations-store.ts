/**
 * SpriteAnimationsStore — animations and their ordered frame lists
 * (migration 196, tables sprite_animations + sprite_frames).
 *
 * A frame is a POINTER at an immutable sprite_asset_versions row — deleting
 * an animation removes only the pointers, never the version files. Frame
 * lists are replaced wholesale in a transaction (reorder/delete/duration
 * edits arrive as the full new list; UNIQUE(animation_id, frame_index) makes
 * partial updates fiddly for no benefit at ≤16 frames). FK cascades don't
 * fire without PRAGMA foreign_keys, so children are deleted explicitly
 * (same caveat as the sibling stores).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { SpriteAnimationRow, SpriteFrameRow, SpriteLoopMode } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

interface RawAnimation {
  id: number; asset_id: number; name: string; fps: number;
  loop_mode: string; status: string; settings_json: string;
  created_at: string; updated_at: string;
}

function mapAnimation(r: RawAnimation): SpriteAnimationRow {
  return {
    id: r.id, asset_id: r.asset_id, name: r.name, fps: r.fps,
    loop_mode: r.loop_mode as SpriteLoopMode, status: r.status,
    settings: r.settings_json ? (JSON.parse(r.settings_json) as Record<string, unknown>) : {},
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export interface SpriteAnimationCreateInput {
  asset_id: number;
  name: string;
  fps?: number;
  loop_mode?: SpriteLoopMode;
  settings?: Record<string, unknown>;
}

export interface SpriteAnimationUpdateInput {
  fps?: number;
  loop_mode?: SpriteLoopMode;
  status?: string;
  settings?: Record<string, unknown>;
}

/** One frame of a replaceFrames() payload (id is assigned by the insert). */
export interface SpriteFrameInput {
  frame_index: number;
  version_id: number;
  duration_ms?: number | null;
}

export class SpriteAnimationsStore {
  constructor(private db: DB) {}

  // ── animations ────────────────────────────────────────────────────────
  listByAsset(assetId: number): SpriteAnimationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sprite_animations WHERE asset_id = ? ORDER BY name')
      .all(assetId) as RawAnimation[];
    return rows.map(mapAnimation);
  }

  get(id: number): SpriteAnimationRow | null {
    const row = this.db.prepare('SELECT * FROM sprite_animations WHERE id = ?').get(id) as
      | RawAnimation
      | undefined;
    return row ? mapAnimation(row) : null;
  }

  /** Throws on UNIQUE(asset_id, name) violation — callers map it to a 409. */
  create(input: SpriteAnimationCreateInput): SpriteAnimationRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_animations (asset_id, name, fps, loop_mode, settings_json)
         VALUES (@asset_id, @name, @fps, @loop_mode, @settings_json)`,
      )
      .run({
        asset_id: input.asset_id,
        name: input.name,
        fps: input.fps ?? 8,
        loop_mode: input.loop_mode ?? 'loop',
        settings_json: JSON.stringify(input.settings ?? {}),
      });
    return this.get(Number(result.lastInsertRowid)) as SpriteAnimationRow;
  }

  /**
   * Shallow-merge keys into settings_json (anchorVersionId, lastGenJobId, …)
   * without clobbering siblings like frameCount. update({settings}) stays the
   * whole-object replace it always was (back-compat).
   */
  mergeSettings(id: number, patch: Record<string, unknown>): boolean {
    const row = this.get(id);
    if (!row) return false;
    return this.update(id, { settings: { ...row.settings, ...patch } });
  }

  update(id: number, input: SpriteAnimationUpdateInput): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.fps !== undefined)       { sets.push('fps = @fps');             params.fps = input.fps; }
    if (input.loop_mode !== undefined) { sets.push('loop_mode = @loop_mode'); params.loop_mode = input.loop_mode; }
    if (input.status !== undefined)    { sets.push('status = @status');       params.status = input.status; }
    if (input.settings !== undefined)  { sets.push('settings_json = @sj');    params.sj = JSON.stringify(input.settings); }
    if (sets.length === 0) return false;
    const result = this.db
      .prepare(`UPDATE sprite_animations SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`)
      .run(params);
    return Number(result.changes) > 0;
  }

  /** Deletes the frame POINTERS too; the version rows/files always survive. */
  delete(id: number): boolean {
    const txn = this.db.transaction((animationId: number) => {
      this.db.prepare('DELETE FROM sprite_frames WHERE animation_id = ?').run(animationId);
      return this.db.prepare('DELETE FROM sprite_animations WHERE id = ?').run(animationId);
    });
    return Number(txn(id).changes) > 0;
  }

  // ── frames ────────────────────────────────────────────────────────────
  listFrames(animationId: number): SpriteFrameRow[] {
    return this.db
      .prepare('SELECT * FROM sprite_frames WHERE animation_id = ? ORDER BY frame_index')
      .all(animationId) as SpriteFrameRow[];
  }

  /**
   * Replace the animation's whole frame list in one transaction (delete +
   * reinsert). Input order wins: frame_index is rewritten to 0..n-1 so
   * callers can pass a reordered list without pre-normalizing.
   */
  replaceFrames(animationId: number, frames: SpriteFrameInput[]): SpriteFrameRow[] {
    const insert = this.db.prepare(
      `INSERT INTO sprite_frames (animation_id, frame_index, version_id, duration_ms)
       VALUES (@animation_id, @frame_index, @version_id, @duration_ms)`,
    );
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM sprite_frames WHERE animation_id = ?').run(animationId);
      frames.forEach((f, i) => {
        insert.run({
          animation_id: animationId,
          frame_index: i,
          version_id: f.version_id,
          duration_ms: f.duration_ms ?? null,
        });
      });
      this.db
        .prepare(`UPDATE sprite_animations SET updated_at = datetime('now') WHERE id = ?`)
        .run(animationId);
    });
    txn();
    return this.listFrames(animationId);
  }
}
