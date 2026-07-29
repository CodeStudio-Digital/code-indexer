import path from 'node:path';
import { exportAsset, type ExportFile, type SpriteExportFormat } from '@mcp/sprite-studio/export/index.js';
import type { AtlasAnimation } from '@mcp/sprite-studio/export/atlas-types.js';
import type { NamedFrame } from '@mcp/sprite-studio/export/spritesheet.js';
import { resolveInsideDir, spriteDir } from '@mcp/sprite-studio/repo/paths.js';
import { isUuid } from '@mcp/session-storage';
import type { ServerDeps } from '../../deps.js';
import { buildExportMeta, resolveAnimationFrames, resolveAssetFrames } from './export-helpers.js';

export const EXPORT_FORMATS = new Set<SpriteExportFormat>([
  'png-individual', 'spritesheet-json', 'phaser', 'unity', 'godot', 'babylon', 'defold', 'cocos',
]);

export type ExportScopeV2 =
  | { kind: 'asset'; assetIds: string[]; includeAnimations?: boolean }
  | { kind: 'animation'; assetId: string; animationIds: string[] }
  | { kind: 'category'; category: string; includeAnimations?: boolean }
  | { kind: 'approved'; includeAnimations?: boolean };

export type ExportTargetV2 =
  | { kind: 'project'; relativeDir?: string }
  | { kind: 'absolute'; path: string };

export interface ExportRequestV2 {
  version: 2;
  scope: ExportScopeV2;
  target?: ExportTargetV2;
  format: SpriteExportFormat;
  options?: {
    padding?: number; extrude?: number; scale?: number;
    trim?: boolean; packing?: 'grid' | 'packed'; defoldImageDir?: string;
  };
}

export interface ExportPlanResult {
  request: ExportRequestV2;
  destination: string;
  assetCount: number;
  frameCount: number;
  animationCount: number;
  files: Array<{ path: string; kind: 'binary' | 'text'; bytes: number }>;
  warnings: string[];
}

export interface BuiltExport {
  plan: ExportPlanResult;
  files: ExportFile[];
  destination: string;
}

const ids = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter(isUuid).map((id) => id.toLowerCase()))]
  : [];

function normalizeV2Scope(value: unknown): ExportScopeV2 | null {
  if (!value || typeof value !== 'object' || !('kind' in value)) return null;
  const scope = value as Record<string, unknown>;
  if (scope.kind === 'asset') {
    const assetIds = ids(scope.assetIds);
    return assetIds.length > 0 ? { kind: 'asset', assetIds, includeAnimations: scope.includeAnimations === true } : null;
  }
  if (scope.kind === 'animation') {
    const animationIds = ids(scope.animationIds);
    return isUuid(scope.assetId) && animationIds.length > 0
      ? { kind: 'animation', assetId: scope.assetId.toLowerCase(), animationIds }
      : null;
  }
  if (scope.kind === 'category') {
    const category = typeof scope.category === 'string' ? scope.category.trim() : '';
    return category ? { kind: 'category', category, includeAnimations: scope.includeAnimations === true } : null;
  }
  return scope.kind === 'approved' ? { kind: 'approved', includeAnimations: scope.includeAnimations === true } : null;
}

function normalizeTarget(value: unknown): ExportTargetV2 | undefined | null {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || !('kind' in value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind === 'project') {
    return typeof target.relativeDir === 'string' && target.relativeDir.trim()
      ? { kind: 'project', relativeDir: target.relativeDir.trim() }
      : { kind: 'project' };
  }
  if (target.kind === 'absolute' && typeof target.path === 'string' && path.isAbsolute(target.path)) {
    return { kind: 'absolute', path: target.path };
  }
  return null;
}

export function normalizeExportRequest(body: unknown): ExportRequestV2 | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Partial<ExportRequestV2>;
  const format = raw.format as SpriteExportFormat | undefined;
  if (!format || !EXPORT_FORMATS.has(format)) return null;
  if (raw.version !== 2 || !raw.scope || typeof raw.scope !== 'object' || !('kind' in raw.scope)) {
    return null;
  }
  const scope = normalizeV2Scope(raw.scope);
  const target = normalizeTarget(raw.target);
  if (!scope || target === null) return null;
  return { version: 2, format, scope, target, options: raw.options };
}

function resolveDestination(root: string, exportDir: string, target: ExportTargetV2 | undefined): string {
  let destination: string;
  if (!target || target.kind === 'project') {
    destination = resolveInsideDir(root, target?.relativeDir?.trim() || exportDir || 'assets/sprites');
  } else {
    if (!path.isAbsolute(target.path)) throw new Error('dest_dir_must_be_absolute');
    destination = path.resolve(target.path);
  }
  const protectedDir = path.resolve(spriteDir(root));
  const rel = path.relative(protectedDir, destination);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('dest_dir_inside_sprite_dir');
  return destination;
}

function includeAnimations(scope: ExportScopeV2): boolean {
  return scope.kind === 'animation' || scope.includeAnimations === true;
}

export async function buildSpriteExport(
  deps: ServerDeps,
  ideProjectId: number,
  request: ExportRequestV2,
): Promise<BuiltExport> {
  const project = await deps.spriteFileStore.projectByIdeId(ideProjectId);
  const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
  if (!project || !root) throw new Error('not_initialized');
  const destination = resolveDestination(root, project.export_dir, request.target);
  let assets = await deps.spriteFileStore.listAssets(project.id);
  if (request.scope.kind === 'asset') {
    const selected = new Set(request.scope.assetIds);
    assets = assets.filter((asset) => selected.has(asset.id));
  } else if (request.scope.kind === 'animation') {
    const assetId = request.scope.assetId;
    assets = assets.filter((asset) => asset.id === assetId);
  } else if (request.scope.kind === 'category') {
    const category = request.scope.category;
    assets = assets.filter((asset) => asset.category === category);
  } else {
    assets = assets.filter((asset) => asset.status === 'approved');
  }
  if (assets.length === 0) throw new Error('not_found');

  const options = request.options ?? {};
  const frames: NamedFrame[] =
    request.scope.kind === 'animation'
      ? []
      : await resolveAssetFrames(deps, root, assets);
  const animations: Record<string, AtlasAnimation> = {};
  if (includeAnimations(request.scope)) {
    for (const asset of assets) {
      const selected = request.scope.kind === 'animation' ? new Set(request.scope.animationIds) : null;
      for (const animation of await deps.spriteFileStore.listAnimations(asset.id)) {
        if (selected && selected.size > 0 && !selected.has(animation.id)) continue;
        const resolved = await resolveAnimationFrames(deps, animation.id, asset.slug);
        if (!resolved) continue;
        frames.push(...resolved.frames);
        animations[resolved.name] = resolved.anim;
      }
    }
  }
  if (frames.length === 0) throw new Error('no_frames');

  const outName = request.scope.kind === 'category'
    ? request.scope.category
    : assets.length === 1 ? assets[0].slug : 'sprites';
  const relativeDestination = request.target?.kind === 'project'
    ? request.target.relativeDir?.trim() || project.export_dir || 'assets/sprites'
    : project.export_dir || 'assets/sprites';
  const resourcePath = `res://${path.posix.join(relativeDestination.replace(/\\/g, '/'), `${outName}.png`)}`;
  const files = exportAsset({
    frames, format: request.format, outName,
    meta: {
      ...buildExportMeta(assets[0].slug, options, Object.values(animations)[0]?.fps, animations),
      resourcePath,
    },
    scale: options.scale,
    packing: options.packing ?? (options.trim ? 'packed' : 'grid'),
    trim: options.trim === true,
    defoldImageDir: options.defoldImageDir,
  });
  const warnings: string[] = [];
  if (request.format === 'png-individual' && Object.keys(animations).length > 0) warnings.push('animations_without_manifest');
  if (request.format === 'babylon') warnings.push('babylon_uniform_duration_only');
  if (request.format === 'cocos') warnings.push('cocos_atlas_only');
  if (request.target?.kind === 'absolute' && request.format === 'godot') warnings.push('godot_resource_path_assumes_project_export_dir');
  const plan: ExportPlanResult = {
    request, destination, assetCount: assets.length, frameCount: frames.length,
    animationCount: Object.keys(animations).length,
    files: files.map((file) => ({
      path: file.relPath, kind: file.bytes ? 'binary' : 'text',
      bytes: file.bytes?.byteLength ?? Buffer.byteLength(file.text ?? '', 'utf8'),
    })),
    warnings,
  };
  return { plan, files, destination };
}
