/**
 * Engine export route — the missing half the ExportDialog always called:
 *
 *   POST /projects/:projectId/export
 *     { scope: 'asset'|'category'|'approved'|'animation', format,
 *       assetId?, category?, animationIds?, includeAnimations?,
 *       destDir?, options: { padding?, extrude?, scale?, defoldImageDir? } }
 *   → 200 { files: string[] }   (absolute paths written)
 *
 * Destination rules: absent destDir → `<root>/<sprite_projects.export_dir>`;
 * present → MUST be absolute (the Electron picker's consent); never inside
 * `.sprite-studio` (source-of-truth protection). Every adapter relPath goes
 * through resolveInsideDir — nothing escapes the chosen folder. Sync on
 * purpose: decoding/compositing dozens of small PNGs is sub-second.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { exportAsset, type SpriteExportFormat } from '@mcp/sprite-studio/export/index.js';
import type { AtlasAnimation } from '@mcp/sprite-studio/export/atlas-types.js';
import type { NamedFrame } from '@mcp/sprite-studio/export/spritesheet.js';
import { resolveInsideDir, spriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { buildExportMeta, resolveAnimationFrames, resolveAssetFrames } from './export-helpers.js';

const FORMATS = new Set<SpriteExportFormat>([
  'png-individual', 'spritesheet-json', 'phaser', 'unity', 'godot', 'babylon', 'defold', 'cocos',
]);

interface ExportBody {
  scope?: 'asset' | 'category' | 'approved' | 'animation';
  format?: string;
  assetId?: number;
  category?: string;
  animationIds?: number[];
  includeAnimations?: boolean;
  destDir?: string;
  options?: { padding?: number; extrude?: number; scale?: number; defoldImageDir?: string };
}

export function mountSpriteExportRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/sprite-studio/projects/:projectId/export', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const project = deps.spriteProjectsStore.getByProjectId(ideProjectId);
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    if (!project || !root) return c.json({ error: 'not_initialized' }, 404);
    const body = (await c.req.json().catch(() => null)) as ExportBody | null;
    const format = body?.format as SpriteExportFormat | undefined;
    if (!body || !format || !FORMATS.has(format)) return c.json({ error: 'invalid_body' }, 400);

    // ── destination ──
    let destDir: string;
    if (body.destDir) {
      if (!path.isAbsolute(body.destDir)) return c.json({ error: 'dest_dir_must_be_absolute' }, 400);
      destDir = path.resolve(body.destDir);
    } else {
      destDir = path.resolve(root, project.export_dir || 'assets/sprites');
    }
    const spriteBase = path.resolve(spriteDir(root)).toLowerCase();
    if (destDir.toLowerCase().startsWith(spriteBase)) {
      return c.json({ error: 'dest_dir_inside_sprite_dir' }, 400);
    }

    // ── scope → assets + animations ──
    const options = body.options ?? {};
    const scope = body.scope ?? 'asset';
    let assets = deps.spriteAssetsStore.list(project.id);
    if (scope === 'asset' || scope === 'animation') {
      assets = assets.filter((a) => a.id === body.assetId);
      if (assets.length === 0) return c.json({ error: 'not_found' }, 404);
    } else if (scope === 'category' && body.category) {
      assets = assets.filter((a) => a.category === body.category);
    } else if (scope === 'approved') {
      assets = assets.filter((a) => a.status === 'approved');
    }

    let frames: NamedFrame[] = [];
    const animations: Record<string, AtlasAnimation> = {};
    try {
      if (scope !== 'animation') frames = resolveAssetFrames(deps, root, assets);
      const wantAnims = scope === 'animation' || body.includeAnimations === true;
      if (wantAnims) {
        for (const asset of assets) {
          const anims = deps.spriteAnimationsStore.listByAsset(asset.id)
            .filter((a) => !body.animationIds || body.animationIds.includes(a.id));
          for (const a of anims) {
            const resolved = resolveAnimationFrames(deps, a.id, asset.slug);
            if (!resolved) continue;
            frames.push(...resolved.frames); // contiguous run per animation
            animations[resolved.name] = resolved.anim;
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith('layer_size_mismatch') ? 422 : 404);
    }
    if (frames.length === 0) return c.json({ error: 'no_frames' }, 400);

    const slug = assets[0]?.slug ?? 'sprites';
    const outName = scope === 'category' && body.category ? body.category : slug;
    const files = exportAsset({
      frames,
      format,
      outName,
      meta: buildExportMeta(slug, options, Object.values(animations)[0]?.fps, animations),
      scale: options.scale,
      defoldImageDir: options.defoldImageDir,
    });

    // ── write (every relPath containment-checked) ──
    const written: string[] = [];
    try {
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of files) {
        const abs = resolveInsideDir(destDir, file.relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (file.bytes) fs.writeFileSync(abs, file.bytes);
        else fs.writeFileSync(abs, file.text ?? '', 'utf8');
        written.push(abs);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ files: written });
  });
}
