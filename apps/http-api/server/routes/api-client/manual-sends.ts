import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { Hono } from 'hono';
import { parseIdParam } from '../_helpers.js';

/** Electron can finish a custom-protocol fetch after the renderer has aborted it.
 * Reserve before dispatch so even a cancel arriving ahead of the send is final. */
export function mountManualSends(app: Hono) {
  const reservations = new Map<string, {
    projectId: number; controller: AbortController; expiry: NodeJS.Timeout; claimed: boolean;
  }>();
  const base = '/api/projects/:projectId/api-client/sends';
  app.post(base, c => {
    const projectId = parseIdParam(c, 'projectId');
    const id = randomUUID();
    const expiry = setTimeout(() => reservations.delete(id), 30000);
    expiry.unref();
    reservations.set(id, { projectId, controller: new AbortController(), expiry, claimed: false });
    return c.json({ id });
  });
  app.delete(`${base}/:id` as const, c => {
    const id = c.req.param('id');
    const item = reservations.get(id);
    if (item?.projectId === parseIdParam(c, 'projectId')) {
      clearTimeout(item.expiry);
      reservations.delete(id);
      item.controller.abort();
    }
    return c.json({ ok: true });
  });
  return createMiddleware<{ Variables: { manualSendSignal: AbortSignal } }>(async (c, next) => {
    const id = c.req.header('X-CodeStudio-Send-Id');
    if (!id) {
      c.set('manualSendSignal', c.req.raw.signal);
      return next();
    }
    const item = reservations.get(id);
    if (!item || item.claimed || item.projectId !== parseIdParam(c, 'projectId')) return c.json({ error: 'Send no longer available' }, 409);
    item.claimed = true;
    clearTimeout(item.expiry);
    c.set('manualSendSignal', AbortSignal.any([c.req.raw.signal, item.controller.signal]));
    try { await next(); } finally { reservations.delete(id); }
  });
}
