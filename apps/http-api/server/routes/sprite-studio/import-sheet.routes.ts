/**
 * Sprite Studio — sprite-sheet import. Upload an existing sheet + a cols×rows
 * grid; slice it into equal cells (reusing the frame-pack slicer) and write
 * each cell as a new immutable 'imported' version. The frontend then builds an
 * animation from the returned versionIds (createAnimation + saveFrames).
 *
 *   POST /projects/:projectId/assets/:assetId/import-sheet   (multipart)
 *     file, cols, rows  →  { versions, versionIds, cellWidth, cellHeight }
 */
import type { Hono } from 'hono';
import { decodeImage } from '@mcp/sprite-studio/processing/decode-image.js';
import { encodePng } from '@mcp/sprite-studio/processing/png.js';
import { sliceGrid } from '@mcp/sprite-studio/processing/slice.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import type { ServerDeps } from '../../deps.js';
import { toVersionDto } from './mappers.js';
import { writeEditedVersion } from './version-write.js';

const MAX_CELLS = 256;
const clampDim = (v: number): number => Math.max(1, Math.min(16, Math.round(v)));

export function mountSpriteImportSheetRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/sprite-studio/projects/:projectId/assets/:assetId/import-sheet', async (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const assetId = c.req.param('assetId');
    const root = deps.db.getProject(ideProjectId)?.root_path ?? null;
    const asset = await deps.spriteFileStore.getAsset(assetId);
    if (!root || !asset) return c.json({ error: 'not_found' }, 404);

    let sheet: Buffer;
    let cols: number;
    let rows: number;
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
      sheet = Buffer.from(await file.arrayBuffer());
      cols = clampDim(Number(form.get('cols')));
      rows = clampDim(Number(form.get('rows')));
    } catch {
      return c.json({ error: 'invalid_multipart' }, 400);
    }
    if (cols * rows > MAX_CELLS) return c.json({ error: 'too_many_cells' }, 400);

    // Decode (PNG/JPEG sniffed) → row-major cells (left→right, top→bottom).
    // Off-thread by default: decode + slice + per-cell encode of a large sheet
    // blocks the Electron main process. Worker unavailable → same compute
    // in-process (old behavior, proper error messages preserved).
    let pngs: Buffer[];
    let cellWidth: number;
    let cellHeight: number;
    try {
      try {
        const out = await getSpriteWorkerClient()
          .sliceGridAdvanced(sheet.toString('base64'), { cols, rows });
        pngs = out.cells.map((b) => Buffer.from(b, 'base64'));
        cellWidth = out.cellWidth;
        cellHeight = out.cellHeight;
      } catch {
        const cells = sliceGrid(decodeImage(sheet), cols, rows);
        pngs = cells.map((cell) => encodePng(cell));
        cellWidth = cells[0]?.width ?? 0;
        cellHeight = cells[0]?.height ?? 0;
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      const versions = await Promise.all(pngs.map((png) =>
        writeEditedVersion(deps, root, asset, png, {
          setCurrent: false, source: 'imported', dims: { width: cellWidth, height: cellHeight },
        }),
      ));
      return c.json({
        versions: versions.map((v) => toVersionDto(ideProjectId, v)),
        versionIds: versions.map((v) => v.id),
        cellWidth,
        cellHeight,
      });
    } catch (e) {
      const msg = (e as Error).message;
      return msg === 'no_manifest' ? c.json({ error: msg }, 404) : c.json({ error: msg }, 400);
    }
  });
}
