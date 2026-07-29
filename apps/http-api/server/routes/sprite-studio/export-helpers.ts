/**
 * Export input assembly: resolve which decoded frames (+ animation metadata)
 * feed `exportAsset()`. Asset scope = the current version per asset (hero
 * frame, name = slug); with animations included, each animation appends its
 * COMPOSITED multi-track columns as a CONTIGUOUS run `{slug}_{anim}_{NNN}` —
 * contiguity is what makes Babylon's from/to and every engine's frame ranges
 * valid.
 */
import fs from 'node:fs';
import { decodeImage } from '@mcp/sprite-studio/processing/decode-image.js';
import { transparentImage } from '@mcp/sprite-studio/processing/composite.js';
import type { NamedFrame } from '@mcp/sprite-studio/export/index.js';
import type { AtlasAnimation, ExportMeta } from '@mcp/sprite-studio/export/atlas-types.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import type { SpriteAssetFileRow } from '../../sprite-files.js';
import { resolveAnim } from './animation-helpers.js';
import { resolveCompositeColumns } from './composite-helpers.js';

/** Hero frame (current version) of each asset; assets without one are skipped. */
export async function resolveAssetFrames(
  deps: ServerDeps,
  root: string,
  assets: SpriteAssetFileRow[],
): Promise<NamedFrame[]> {
  const out: NamedFrame[] = [];
  for (const asset of [...assets].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (asset.current_version_id == null) continue;
    const version = await deps.spriteFileStore.getVersion(asset.current_version_id);
    if (!version) continue;
    const png = fs.readFileSync(resolveInsideSpriteDir(root, version.file_rel_path));
    out.push({ name: asset.slug, img: decodeImage(png) });
  }
  return out;
}

/**
 * One animation's frames as composited columns (visible tracks). Empty
 * columns render transparent at the grid size — timing holds are real frames.
 */
export async function resolveAnimationFrames(
  deps: ServerDeps,
  animationId: string,
  slug: string,
): Promise<{ frames: NamedFrame[]; name: string; anim: AtlasAnimation } | null> {
  const ctx = await resolveAnim(deps, animationId);
  if (!ctx || !ctx.root) return null;
  const columns = await resolveCompositeColumns(deps, ctx);
  if (columns.length === 0) return null;
  const ref = columns.find((c) => c.image != null)?.image;
  if (!ref) return null;
  const exportName = typeof ctx.anim.settings.exportName === 'string' && ctx.anim.settings.exportName.trim()
    ? ctx.anim.settings.exportName.trim()
    : ctx.anim.name;
  const frames: NamedFrame[] = columns.map((col, i) => ({
    name: `${slug}_${exportName}_${String(i).padStart(3, '0')}`,
    img: col.image ?? transparentImage(ref.width, ref.height),
  }));
  return {
    frames,
    name: `${slug}_${exportName}`,
    anim: {
      frames: frames.map((f) => f.name),
      fps: ctx.anim.fps,
      loop: ctx.anim.loop_mode !== 'once',
      loopMode: ctx.anim.loop_mode,
      durationsMs: columns.map((c) => c.durationMs),
      action: typeof ctx.anim.settings.actionKey === 'string' ? ctx.anim.settings.actionKey : ctx.anim.name,
      direction: typeof ctx.anim.settings.direction === 'string' ? ctx.anim.settings.direction : undefined,
    },
  };
}

/** Meta defaults: bottom-center pivot (feet on ground) + option pass-through. */
export function buildExportMeta(
  assetSlug: string,
  options: { padding?: number; extrude?: number; scale?: number },
  fps: number | undefined,
  animations: Record<string, AtlasAnimation>,
): ExportMeta {
  return {
    assetSlug,
    scale: typeof options.scale === 'number' ? Math.max(1, Math.floor(options.scale)) : 1,
    padding: typeof options.padding === 'number' ? Math.max(0, Math.floor(options.padding)) : 2,
    extrude: typeof options.extrude === 'number' ? Math.max(0, Math.floor(options.extrude)) : 2,
    pivot: { x: 0.5, y: 1 },
    fps,
    ...(Object.keys(animations).length > 0 ? { animations } : {}),
  };
}
