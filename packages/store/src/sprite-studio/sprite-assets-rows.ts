/**
 * Sprite Studio — raw DB row shapes, row mappers and write-input types for
 * SpriteAssetsStore (migration 196). Split out of sprite-assets-store.ts to
 * keep both files under the 200-LOC ceiling; the store class is the only
 * intended consumer of the Raw/map pairs, the Input types are public API.
 */
import type {
  SpriteAssetRow,
  SpriteAssetStatus,
  SpriteAssetVersionRow,
  SpriteVersionSource,
} from './types.js';

export interface RawAsset {
  id: number; sprite_project_id: number; slug: string; display_name: string;
  category: string; tags_json: string; status: string;
  current_version_id: number | null; anchor_reference_id: number | null;
  created_at: string; updated_at: string;
}

export function mapAsset(r: RawAsset): SpriteAssetRow {
  return {
    id: r.id, sprite_project_id: r.sprite_project_id, slug: r.slug,
    display_name: r.display_name, category: r.category,
    tags: r.tags_json ? (JSON.parse(r.tags_json) as string[]) : [],
    status: r.status as SpriteAssetStatus,
    current_version_id: r.current_version_id,
    anchor_reference_id: r.anchor_reference_id,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

export interface RawVersion {
  id: number; asset_id: number; version: number; file_rel_path: string;
  width: number | null; height: number | null; source: string;
  prompt: string | null; user_intent: string | null; gen_params_json: string | null;
  parent_version_id: number | null; job_id: number | null;
  content_hash: string | null; created_at: string;
}

export function mapVersion(r: RawVersion): SpriteAssetVersionRow {
  return {
    id: r.id, asset_id: r.asset_id, version: r.version,
    file_rel_path: r.file_rel_path, width: r.width, height: r.height,
    source: r.source as SpriteVersionSource,
    prompt: r.prompt, user_intent: r.user_intent,
    gen_params: r.gen_params_json ? (JSON.parse(r.gen_params_json) as Record<string, unknown>) : null,
    parent_version_id: r.parent_version_id, job_id: r.job_id,
    content_hash: r.content_hash, created_at: r.created_at,
  };
}

export interface SpriteAssetCreateInput {
  sprite_project_id: number; slug: string; display_name: string;
  category?: string; tags?: string[]; status?: SpriteAssetStatus;
}

export interface SpriteAssetUpdateInput {
  display_name?: string; category?: string; tags?: string[];
  status?: SpriteAssetStatus; anchor_reference_id?: number | null;
}

export interface SpriteVersionInsertInput {
  asset_id: number; version?: number; file_rel_path: string;
  width?: number | null; height?: number | null; source: SpriteVersionSource;
  prompt?: string | null; user_intent?: string | null;
  gen_params?: Record<string, unknown> | null; parent_version_id?: number | null;
  job_id?: number | null; content_hash?: string | null;
}

export interface SpriteReferenceInsertInput {
  sprite_project_id: number; asset_id?: number | null; kind: string;
  file_rel_path: string; notes?: string | null;
}
