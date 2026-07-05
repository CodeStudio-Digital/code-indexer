/**
 * Original-sheet routes: serve a generation's persisted combined sheet and
 * re-slice it with a CUSTOM grid (cols/rows + offset/margin) into fresh frame
 * versions. Lets the user recover clean frames when the model's auto-grid was
 * off; the dashboard then sets the result as the animation's timeline.
 *
 *   GET  /projects/:projectId/jobs/:jobId/sheet                the raw sheet PNG
 *   POST /projects/:projectId/assets/:assetId/reslice-sheet    custom re-cut
 */
import fs from 'node:fs';
import type { Hono } from 'hono';
import { decodeImage } from '@mcp/sprite-studio/processing/decode-image.js';
import { encodePng } from '@mcp/sprite-studio/processing/png.js';
import { sliceGridAdvanced } from '@mcp/sprite-studio/processing/slice.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import type { ServerDeps } from '../../deps.js';
import { toVersionDto } from './mappers.js';
import { sheetAbsPath } from './sheet-artifact.js';
import { writeEditedVersion } from './version-write.js';

const MAX_CELLS = 256;
const clampDim = (v: number): number => Math.max(1, Math.min(16, Math.round(v)));
const clampPx = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);

export function mountSpriteSheetRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/sprite-studio/projects/:projectId/jobs/:jobId/sheet', (c) => {
    const root = deps.db.getProject(Number(c.req.param('projectId')))?.root_path ?? null;
    const job = deps.spriteJobsStore.get(Number(c.req.param('jobId')));
    const asset = job?.asset_id != null ? deps.spriteAssetsStore.get(job.asset_id) : null;
    if (!root || !job || !asset) return c.json({ error: 'not_found' }, 404);
    let png: Buffer;
    try {
      png = fs.readFileSync(sheetAbsPath(root, asset.slug, job.id));
    } catch {
      return c.json({ error: 'no_sheet' }, 404);
    }
    return c.body(new Uint8Array(png), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300' },
    });
  });

  app.post('/api/sprite-studio/projects/:projectId/assets/:assetId/reslice-sheet', async (c) => {
    const root = deps.db.getProject(Number(c.req.param('projectId')))?.root_path ?? null;
    const asset = deps.spriteAssetsStore.get(Number(c.req.param('assetId')));
    if (!root || !asset) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | {
          jobId?: number; cols?: number; rows?: number;
          offsetX?: number; offsetY?: number; marginX?: number; marginY?: number;
          offsets?: Array<{ dx?: number; dy?: number } | null> | null;
        }
      | null;
    if (!body?.jobId) return c.json({ error: 'invalid_body' }, 400);
    const job = deps.spriteJobsStore.get(body.jobId);
    if (!job || job.asset_id !== asset.id) return c.json({ error: 'job_mismatch' }, 400);

    let sheet: Buffer;
    try {
      sheet = fs.readFileSync(sheetAbsPath(root, asset.slug, job.id));
    } catch {
      return c.json({ error: 'no_sheet' }, 404);
    }
    const cols = clampDim(Number(body.cols) || 1);
    const rows = clampDim(Number(body.rows) || 1);
    if (cols * rows > MAX_CELLS) return c.json({ error: 'too_many_cells' }, 400);
    // Per-cell manual nudges (row-major); bounded to the grid, sanitised to ints.
    const offsets = Array.isArray(body.offsets)
      ? body.offsets.slice(0, cols * rows).map((o) => ({
          dx: Number.isFinite(Number(o?.dx)) ? Math.trunc(Number(o?.dx)) : 0,
          dy: Number.isFinite(Number(o?.dy)) ? Math.trunc(Number(o?.dy)) : 0,
        }))
      : undefined;

    const opts = {
      cols, rows,
      offsetX: clampPx(body.offsetX), offsetY: clampPx(body.offsetY),
      marginX: clampPx(body.marginX), marginY: clampPx(body.marginY),
      offsets,
    };
    let pngs: Buffer[];
    let cellWidth: number;
    let cellHeight: number;
    try {
      try {
        // Off-thread: decode + slice + per-cell encode of a large sheet blocks
        // the Electron main process for hundreds of ms.
        const out = await getSpriteWorkerClient().sliceGridAdvanced(sheet.toString('base64'), opts);
        pngs = out.cells.map((b) => Buffer.from(b, 'base64'));
        cellWidth = out.cellWidth;
        cellHeight = out.cellHeight;
      } catch {
        // Worker unavailable/crashed → same compute in-process (old behavior,
        // and re-throws genuine slice errors with their proper message).
        const cells = sliceGridAdvanced(decodeImage(sheet), opts);
        pngs = cells.map((cell) => encodePng(cell));
        cellWidth = cells[0]?.width ?? 0;
        cellHeight = cells[0]?.height ?? 0;
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    try {
      const versions = pngs.map((png) =>
        writeEditedVersion(deps, root, asset, png, {
          setCurrent: false, source: 'imported', dims: { width: cellWidth, height: cellHeight },
        }),
      );
      return c.json({
        versions: versions.map((v) => toVersionDto(Number(c.req.param('projectId')), v)),
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
