/**
 * Store-row → dashboard-DTO mappers. The frontend (apps/dashboard/features/
 * sprite-studio/types.ts) has its own shapes; http-api can't import them, so
 * the DTO field names are reproduced here and rows are projected onto them.
 * The URL builders match the frontend's `versionFileUrl`/`versionThumbUrl`.
 */
import type {
  SpriteProjectRow,
} from '@mcp/store/sprite-studio/types.js';
import type {
  SpriteAssetFileRow,
  SpriteVersionFileRow,
} from '../../sprite-files.js';
import { styleToStudioSettings } from './settings-map.js';

const base = (projectId: number) => `/api/sprite-studio/projects/${projectId}`;

export function versionFileUrl(projectId: number, versionId: string): string {
  return `${base(projectId)}/versions/${versionId}/file`;
}
export function versionThumbUrl(projectId: number, versionId: string, s = 128): string {
  return `${base(projectId)}/versions/${versionId}/thumb?s=${s}`;
}

/** Project row → SpriteProjectInfo DTO. Prefers the stored UI settings blob. */
export function toProjectInfo(row: SpriteProjectRow): Record<string, unknown> {
  const settings =
    row.settings && Object.keys(row.settings).length > 0
      ? row.settings
      : styleToStudioSettings(row.style);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    settings,
    styleVersion: 1,
    exportDir: row.export_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Asset row → SpriteAsset DTO. `thumbUrl` points at the current version. */
export function toAssetDto(
  ideProjectId: number,
  row: SpriteAssetFileRow,
  size: { width: number; height: number },
): Record<string, unknown> {
  return {
    id: row.id,
    spriteProjectId: row.sprite_project_id,
    slug: row.slug,
    name: row.display_name,
    category: row.category,
    tags: row.tags,
    status: row.status,
    currentVersionId: row.current_version_id,
    width: size.width,
    height: size.height,
    thumbUrl: row.current_version_id ? versionThumbUrl(ideProjectId, row.current_version_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A generation batch (grouped versions) → GenerationGroupDto for the Frames
 * browser header ("job#40 · idle · 6f"). `job`/`animationName` are resolved by
 * the route (sibling stores); a null jobId is the synthetic 'manual' bucket
 * (hand-edited / imported / aligned versions). The frontend builds thumb URLs
 * from versionIds via versionThumbUrl.
 */
export function toGenerationGroupDto(
  group: { jobId: string | null; versionIds: string[]; createdAt: string },
  job: { kind: string; user_intent: string | null; request: Record<string, unknown> | null } | null,
  animationName: string | null,
  hasSheet: boolean,
): Record<string, unknown> {
  const animationId =
    job?.request &&
    typeof job.request.animation_id === 'string'
      ? job.request.animation_id
      : null;
  return {
    jobId: group.jobId,
    kind: group.jobId == null ? 'manual' : job?.kind ?? 'generate',
    animationId,
    animationName,
    prompt: job?.user_intent ?? null,
    frameCount: group.versionIds.length,
    createdAt: group.createdAt,
    versionIds: group.versionIds,
    /** The original combined sheet is kept (re-sliceable) for this batch. */
    hasSheet,
  };
}

/** Version row → AssetVersion DTO with file + thumb URLs. */
export function toVersionDto(
  ideProjectId: number,
  row: SpriteVersionFileRow,
): Record<string, unknown> {
  return {
    id: row.id,
    assetId: row.asset_id,
    version: row.version,
    fileUrl: versionFileUrl(ideProjectId, row.id),
    thumbUrl: versionThumbUrl(ideProjectId, row.id),
    width: row.width ?? 0,
    height: row.height ?? 0,
    source: row.source,
    prompt: row.prompt,
    parentVersionId: row.parent_version_id,
    jobId: row.job_id,
    // Cache-bust handle: in-place overwrites keep the id but change the hash.
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}
