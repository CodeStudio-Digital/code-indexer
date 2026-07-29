/**
 * Hono routes for the Builder checkpoint timeline:
 *   GET    /api/projects/:id/checkpoints                 → rows (newest first)
 *   POST   /api/projects/:id/checkpoints/:cid/restore    → forward-only restore
 *   GET    /api/projects/:id/checkpoints/:cid/diff[?from]→ unified patch
 *   GET    /api/projects/:id/checkpoints/:cid/thumbnail  → image artifact
 */
import type { Hono } from 'hono';
import { ApiError } from '@mcp/api-bus';
import {
  checkpointDiff,
  checkpointThumbnail,
  createCheckpointNow,
  listCheckpoints,
  restoreCheckpoint,
} from '../builder-checkpoint-service.js';
import { isUuid } from '@mcp/session-storage';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, notFound } from './_helpers.js';
import type { Context } from 'hono';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

function parseCheckpointId(value: string | undefined): string {
  if (!isUuid(value)) {
    throw new ApiError('bad_request', 400, 'invalid checkpoint UUID');
  }
  return value.toLowerCase();
}

export function mountBuilderCheckpointRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/projects/:id/checkpoints', async (c) => {
    try {
      return c.json({
        checkpoints: await listCheckpoints(deps, parseIdParam(c)),
      });
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Land the current dirty tree as a checkpoint (visual-edit bursts /
  // manual "save point"). No-op `{checkpoint: null}` on a clean tree.
  app.post('/api/projects/:id/checkpoints', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        label?: string;
        kind?: string;
        session_id?: string;
      };
      return c.json(
        await createCheckpointNow(deps, parseIdParam(c), {
          label: typeof body.label === 'string' ? body.label : '',
          kind: body.kind === 'manual' ? 'manual' : 'visual',
          ...(typeof body.session_id === 'string'
            ? { session_id: body.session_id }
            : {}),
        }),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/checkpoints/:cid/restore', async (c) => {
    try {
      return c.json(
        await restoreCheckpoint(
          deps,
          parseIdParam(c),
          parseCheckpointId(c.req.param('cid')),
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/checkpoints/:cid/diff', async (c) => {
    try {
      const fromRaw = c.req.query('from');
      const from =
        fromRaw != null && fromRaw !== ''
          ? parseCheckpointId(fromRaw)
          : undefined;
      return c.json(
        await checkpointDiff(
          deps,
          parseIdParam(c),
          parseCheckpointId(c.req.param('cid')),
          from,
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/checkpoints/:cid/thumbnail', async (c) => {
    try {
      const thumbnail = await checkpointThumbnail(
        deps,
        parseIdParam(c),
        parseCheckpointId(c.req.param('cid')),
      );
      if (!thumbnail) return notFound(c);
      return c.body(
        thumbnail.bytes.buffer.slice(
          thumbnail.bytes.byteOffset,
          thumbnail.bytes.byteOffset + thumbnail.bytes.byteLength,
        ) as ArrayBuffer,
        200,
        {
        'content-type': thumbnail.mediaType,
        'cache-control': 'private, max-age=86400, immutable',
        },
      );
    } catch (err) {
      if (err instanceof ApiError) return mapApiError(c, err);
      return notFound(c);
    }
  });
}
