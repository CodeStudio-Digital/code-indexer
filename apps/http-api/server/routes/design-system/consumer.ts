/**
 * Routes — link/unlink a published Design System to a Builder project.
 *
 *   POST   /api/projects/:id/design-system/link   {ds_session_id, semver?}
 *   DELETE /api/projects/:id/design-system/link
 *
 * Thin adapters over `@mcp/api-handlers` linkDesignSystem/unlinkDesignSystem
 * (same business logic the wizard scaffold reuses). Install hits the local
 * Verdaccio (fast), so a plain JSON response is enough — no SSE.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { ApiError } from '@mcp/api-bus';
import { linkDesignSystem, unlinkDesignSystem } from '@mcp/api-handlers';
import type { ServerDeps } from '../../deps.js';
import {
  parseIdParam,
  parseJsonBody,
  parseSessionIdValue,
} from '../_helpers.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status as never);
  }
  throw err;
}

export function mountDesignSystemConsumerRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/projects/:id/design-system/link', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await parseJsonBody<{ ds_session_id?: string; semver?: string }>(c);
      if (typeof body.ds_session_id !== 'string') {
        return c.json({ error: 'ds_session_id is required', code: 'bad_request' }, 400);
      }
      const dsSessionId = parseSessionIdValue(
        body.ds_session_id,
        'ds_session_id',
      );
      const semver = typeof body.semver === 'string' && body.semver ? body.semver : undefined;
      return c.json(await linkDesignSystem(deps, { projectId, dsSessionId, semver }, c.req.raw.signal));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.delete('/api/projects/:id/design-system/link', async (c) => {
    try {
      const projectId = parseIdParam(c);
      return c.json(await unlinkDesignSystem(deps, { projectId }, c.req.raw.signal));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
