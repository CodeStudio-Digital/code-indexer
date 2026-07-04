/**
 * Sprite Studio — per-project SSE stream.
 *
 *   GET /api/sprite-studio/projects/:projectId/stream
 *
 * Long-lived: the bus is never markEnded, so `pumpBusToSSE` stays open until
 * the client disconnects (its abort signal resolves `waitEnded`). Job events
 * (sprite_job / sprite_variant_ready / sprite_job_done / sprite_job_failed)
 * are published onto the project's bus by the runner via emitSpriteEvent.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { getSpriteBus } from './bus-registry.js';

export function mountSpriteStreamRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/sprite-studio/projects/:projectId/stream', (c) => {
    const ideProjectId = Number(c.req.param('projectId'));
    const project = deps.spriteProjectsStore.getByProjectId(ideProjectId);
    if (!project) return c.json({ error: 'not_initialized' }, 404);
    const bus = getSpriteBus(project.id);
    return pumpBusToSSE(c, bus, { since: parseLastEventId(c), heartbeat: true });
  });
}
