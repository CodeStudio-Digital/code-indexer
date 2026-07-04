/**
 * SpriteAssetsStore — assets, immutable versions and reference images
 * (migration 196). Rows mirror the repo manifests (`asset.json`); versions
 * are append-only (v001, v002, ...) and never overwritten.
 *
 * Deleting an asset removes its children explicitly (frames → animations →
 * versions → asset-scoped references) — FK cascades don't fire without
 * PRAGMA foreign_keys. Jobs are an append-only cost ledger, so asset
 * deletion only detaches them (asset_id → NULL), never deletes.
 *
 * Row shapes / mappers / input types live in ./sprite-assets-rows.ts.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { SpriteAssetRow, SpriteAssetStatus, SpriteAssetVersionRow, SpriteReferenceRow } from './types.js';
import {
  mapAsset,
  mapVersion,
  type RawAsset,
  type RawVersion,
  type SpriteAssetCreateInput,
  type SpriteAssetUpdateInput,
  type SpriteReferenceInsertInput,
  type SpriteVersionInsertInput,
} from './sprite-assets-rows.js';

export type {
  SpriteAssetCreateInput,
  SpriteAssetUpdateInput,
  SpriteReferenceInsertInput,
  SpriteVersionInsertInput,
} from './sprite-assets-rows.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export class SpriteAssetsStore {
  constructor(private db: DB) {}

  // ── assets ────────────────────────────────────────────────────────────
  list(spriteProjectId: number, filters: { category?: string; status?: SpriteAssetStatus; q?: string } = {}): SpriteAssetRow[] {
    const where = ['sprite_project_id = @spriteProjectId'];
    const params: Record<string, unknown> = { spriteProjectId };
    if (filters.category) { where.push('category = @category'); params.category = filters.category; }
    if (filters.status)   { where.push('status = @status');     params.status = filters.status; }
    if (filters.q)        { where.push('(slug LIKE @q OR display_name LIKE @q)'); params.q = `%${filters.q}%`; }
    const rows = this.db
      .prepare(`SELECT * FROM sprite_assets WHERE ${where.join(' AND ')} ORDER BY slug`)
      .all(params) as RawAsset[];
    return rows.map(mapAsset);
  }

  get(id: number): SpriteAssetRow | null {
    const row = this.db.prepare('SELECT * FROM sprite_assets WHERE id = ?').get(id) as RawAsset | undefined;
    return row ? mapAsset(row) : null;
  }

  create(input: SpriteAssetCreateInput): SpriteAssetRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_assets (sprite_project_id, slug, display_name, category, tags_json, status)
         VALUES (@sprite_project_id, @slug, @display_name, @category, @tags_json, @status)`,
      )
      .run({
        sprite_project_id: input.sprite_project_id,
        slug: input.slug,
        display_name: input.display_name,
        category: input.category ?? 'misc',
        tags_json: JSON.stringify(input.tags ?? []),
        status: input.status ?? 'draft',
      });
    return this.get(Number(result.lastInsertRowid)) as SpriteAssetRow;
  }

  updateMeta(id: number, input: SpriteAssetUpdateInput): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.display_name !== undefined) { sets.push('display_name = @display_name'); params.display_name = input.display_name; }
    if (input.category !== undefined)     { sets.push('category = @category');         params.category = input.category; }
    if (input.tags !== undefined)         { sets.push('tags_json = @tags_json');       params.tags_json = JSON.stringify(input.tags); }
    if (input.status !== undefined)       { sets.push('status = @status');             params.status = input.status; }
    if (input.anchor_reference_id !== undefined) { sets.push('anchor_reference_id = @anchor'); params.anchor = input.anchor_reference_id; }
    if (sets.length === 0) return false;
    const result = this.db
      .prepare(`UPDATE sprite_assets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`)
      .run(params);
    return Number(result.changes) > 0;
  }

  setCurrentVersion(assetId: number, versionId: number | null): boolean {
    const result = this.db
      .prepare(`UPDATE sprite_assets SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(versionId, assetId);
    return Number(result.changes) > 0;
  }

  /** Explicit child deletes; generation jobs are detached (ledger survives). */
  delete(id: number): boolean {
    const txn = this.db.transaction((assetId: number) => {
      this.db
        .prepare('DELETE FROM sprite_frames WHERE animation_id IN (SELECT id FROM sprite_animations WHERE asset_id = ?)')
        .run(assetId);
      this.db.prepare('DELETE FROM sprite_animations WHERE asset_id = ?').run(assetId);
      this.db.prepare('DELETE FROM sprite_asset_versions WHERE asset_id = ?').run(assetId);
      this.db.prepare('DELETE FROM sprite_references WHERE asset_id = ?').run(assetId);
      this.db.prepare('UPDATE sprite_generation_jobs SET asset_id = NULL WHERE asset_id = ?').run(assetId);
      return this.db.prepare('DELETE FROM sprite_assets WHERE id = ?').run(assetId);
    });
    return Number(txn(id).changes) > 0;
  }

  // ── versions (immutable, append-only) ─────────────────────────────────
  listVersions(assetId: number): SpriteAssetVersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sprite_asset_versions WHERE asset_id = ? ORDER BY version DESC')
      .all(assetId) as RawVersion[];
    return rows.map(mapVersion);
  }

  nextVersionNumber(assetId: number): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS max_version FROM sprite_asset_versions WHERE asset_id = ?')
      .get(assetId) as { max_version: number | null };
    return (row.max_version ?? 0) + 1;
  }

  insertVersion(input: SpriteVersionInsertInput): SpriteAssetVersionRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_asset_versions (
           asset_id, version, file_rel_path, width, height, source, prompt,
           user_intent, gen_params_json, parent_version_id, job_id, content_hash
         ) VALUES (
           @asset_id, @version, @file_rel_path, @width, @height, @source, @prompt,
           @user_intent, @gen_params_json, @parent_version_id, @job_id, @content_hash
         )`,
      )
      .run({
        asset_id: input.asset_id,
        version: input.version ?? this.nextVersionNumber(input.asset_id),
        file_rel_path: input.file_rel_path,
        width: input.width ?? null,
        height: input.height ?? null,
        source: input.source,
        prompt: input.prompt ?? null,
        user_intent: input.user_intent ?? null,
        gen_params_json: input.gen_params != null ? JSON.stringify(input.gen_params) : null,
        parent_version_id: input.parent_version_id ?? null,
        job_id: input.job_id ?? null,
        content_hash: input.content_hash ?? null,
      });
    return this.getVersion(Number(result.lastInsertRowid)) as SpriteAssetVersionRow;
  }

  getVersion(id: number): SpriteAssetVersionRow | null {
    const row = this.db.prepare('SELECT * FROM sprite_asset_versions WHERE id = ?').get(id) as RawVersion | undefined;
    return row ? mapVersion(row) : null;
  }

  /**
   * In-place content overwrite (focused frame edit): the file bytes changed
   * but the version NUMBER and file path stay — only dims/hash/source move.
   * The one sanctioned mutation of a version row besides deletion.
   */
  updateVersionContent(
    id: number,
    input: { width: number; height: number; content_hash: string },
  ): SpriteAssetVersionRow | null {
    const result = this.db
      .prepare(
        `UPDATE sprite_asset_versions
            SET width = @width, height = @height, content_hash = @content_hash, source = 'edited'
          WHERE id = @id`,
      )
      .run({ id, width: input.width, height: input.height, content_hash: input.content_hash });
    return Number(result.changes) > 0 ? this.getVersion(id) : null;
  }

  /**
   * Curation delete of one version — delegates to the batch path so there is a
   * single delete implementation. Frames referencing it go first (FK cascades
   * don't fire without PRAGMA) and the owning asset's current_version_id falls
   * back to the newest remaining version.
   */
  deleteVersion(id: number): boolean {
    return this.deleteVersions([id]).deleted.length > 0;
  }

  /**
   * Batch curation delete (the Frames-browser "excluir vários"). One
   * transaction: tally the frames that reference the doomed versions (per
   * animation, BEFORE deleting) so the caller can warn which animations got
   * shortened, drop those frame pointers, delete the version rows, then
   * recompute each affected asset's current-version pointer ONCE at the end.
   * `missing` = ids that were already gone (reported, never an error).
   */
  deleteVersions(ids: number[]): {
    deleted: number[];
    missing: number[];
    framesByAnimation: Record<number, number>;
  } {
    const txn = this.db.transaction((wanted: number[]) => {
      const found: SpriteAssetVersionRow[] = [];
      const missing: number[] = [];
      for (const id of wanted) {
        const row = this.getVersion(id);
        if (row) found.push(row);
        else missing.push(id);
      }
      const framesByAnimation: Record<number, number> = {};
      if (found.length === 0) return { deleted: [] as number[], missing, framesByAnimation };
      const foundIds = found.map((v) => v.id);
      const ph = foundIds.map(() => '?').join(',');
      const tally = this.db
        .prepare(`SELECT animation_id AS a, COUNT(*) AS c FROM sprite_frames WHERE version_id IN (${ph}) GROUP BY animation_id`)
        .all(...foundIds) as Array<{ a: number; c: number }>;
      for (const t of tally) framesByAnimation[t.a] = t.c;
      this.db.prepare(`DELETE FROM sprite_frames WHERE version_id IN (${ph})`).run(...foundIds);
      this.db.prepare(`DELETE FROM sprite_asset_versions WHERE id IN (${ph})`).run(...foundIds);
      const deletedSet = new Set(foundIds);
      for (const assetId of new Set(found.map((v) => v.asset_id))) {
        const asset = this.get(assetId);
        if (asset?.current_version_id != null && deletedSet.has(asset.current_version_id)) {
          const latest = this.listVersions(assetId)[0] ?? null;
          this.setCurrentVersion(assetId, latest?.id ?? null);
        }
      }
      return { deleted: foundIds, missing, framesByAnimation };
    });
    return txn(ids);
  }

  /**
   * Versions grouped by generation batch (job_id) for the Frames browser.
   * job_id NULL rows (hand-edited/aligned/imported) fold into one synthetic
   * 'loose' group. Groups keep discovery order (newest version first → newest
   * batch first); versionIds within a group are version-ascending so they read
   * frame_1..frame_n. Enrichment (job kind/intent, animation name) is joined in
   * the route where the sibling stores are in scope.
   */
  listVersionGroups(assetId: number): Array<{ jobId: number | null; versionIds: number[]; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT id, version, job_id, created_at FROM sprite_asset_versions WHERE asset_id = ? ORDER BY version DESC')
      .all(assetId) as Array<{ id: number; version: number; job_id: number | null; created_at: string }>;
    const byKey = new Map<string, { jobId: number | null; versions: Array<{ id: number; version: number }>; createdAt: string }>();
    const order: string[] = [];
    for (const r of rows) {
      const key = r.job_id == null ? 'loose' : `job:${r.job_id}`;
      let g = byKey.get(key);
      if (!g) {
        g = { jobId: r.job_id, versions: [], createdAt: r.created_at };
        byKey.set(key, g);
        order.push(key);
      }
      g.versions.push({ id: r.id, version: r.version });
      if (r.created_at > g.createdAt) g.createdAt = r.created_at;
    }
    return order.map((k) => {
      const g = byKey.get(k) as { jobId: number | null; versions: Array<{ id: number; version: number }>; createdAt: string };
      return {
        jobId: g.jobId,
        versionIds: g.versions.sort((a, b) => a.version - b.version).map((v) => v.id),
        createdAt: g.createdAt,
      };
    });
  }

  // ── references (no JSON columns — raw row IS the domain row) ──────────
  listReferences(spriteProjectId: number, assetId?: number | null): SpriteReferenceRow[] {
    return (assetId === undefined
      ? this.db.prepare('SELECT * FROM sprite_references WHERE sprite_project_id = ? ORDER BY id').all(spriteProjectId)
      : this.db.prepare('SELECT * FROM sprite_references WHERE sprite_project_id = ? AND asset_id IS ? ORDER BY id').all(spriteProjectId, assetId)
    ) as SpriteReferenceRow[];
  }

  insertReference(input: SpriteReferenceInsertInput): SpriteReferenceRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_references (sprite_project_id, asset_id, kind, file_rel_path, notes)
         VALUES (@sprite_project_id, @asset_id, @kind, @file_rel_path, @notes)`,
      )
      .run({
        sprite_project_id: input.sprite_project_id,
        asset_id: input.asset_id ?? null,
        kind: input.kind,
        file_rel_path: input.file_rel_path,
        notes: input.notes ?? null,
      });
    return this.db
      .prepare('SELECT * FROM sprite_references WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as SpriteReferenceRow;
  }

  deleteReference(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM sprite_references WHERE id = ?').run(id).changes) > 0;
  }
}
