/**
 * Hono routes for the Builder checkpoint timeline:
 *   GET    /api/projects/:id/checkpoints                 → rows (newest first)
 *   POST   /api/projects/:id/checkpoints/:cid/restore    → forward-only restore
 *   GET    /api/projects/:id/checkpoints/:cid/diff[?from]→ unified patch
 *   GET    /api/projects/:id/checkpoints/:cid/thumbnail  → JPEG (404 = placeholder)
 */
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { ApiError } from '@mcp/api-bus';
import {
  checkpointDiff,
  createCheckpointNow,
  listCheckpoints,
  restoreCheckpoint,
} from '@mcp/api-handlers/builder/checkpoints.js';
import { getBuilderCheckpoint } from '@mcp/store/db/builder-checkpoints.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';
import type { Context } from 'hono';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

function parseCid(c: Context): number {
  const cid = Number(c.req.param('cid'));
  if (!Number.isFinite(cid) || cid <= 0) throw new ApiError('bad_request', 400, 'invalid checkpoint id');
  return cid;
}

export function mountBuilderCheckpointRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/projects/:id/checkpoints', (c) => {
    try {
      return c.json({ checkpoints: listCheckpoints(deps, parseIdParam(c)) });
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Land the current dirty tree as a checkpoint (visual-edit bursts /
  // manual "save point"). No-op `{checkpoint: null}` on a clean tree.
  app.post('/api/projects/:id/checkpoints', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { label?: string; kind?: string };
      return c.json(
        await createCheckpointNow(deps, parseIdParam(c), {
          label: typeof body.label === 'string' ? body.label : '',
          kind: body.kind === 'manual' ? 'manual' : 'visual',
        }),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/checkpoints/:cid/restore', async (c) => {
    try {
      return c.json(await restoreCheckpoint(deps, parseIdParam(c), parseCid(c)));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/checkpoints/:cid/diff', async (c) => {
    try {
      const fromRaw = c.req.query('from');
      const from = fromRaw != null && fromRaw !== '' ? Number(fromRaw) : undefined;
      return c.json(await checkpointDiff(deps, parseIdParam(c), parseCid(c), from));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/checkpoints/:cid/thumbnail', (c) => {
    try {
      const projectId = parseIdParam(c);
      const row = getBuilderCheckpoint(deps.db.projectScopedDb(projectId), parseCid(c));
      if (!row || row.project_id !== projectId || !row.screenshot_path) return notFound(c);
      const bytes = readFileSync(row.screenshot_path);
      return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, {
        'content-type': 'image/jpeg',
        'cache-control': 'private, max-age=86400, immutable',
      });
    } catch (err) {
      if (err instanceof ApiError) return mapApiError(c, err);
      return notFound(c); // file vanished — card falls back to the placeholder
    }
  });
}
