import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  parseJsonBody,
  parseSessionIdParam,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';

/**
 * HTTP routes for the Session Drive — a single coder session's durable
 * working memory stored in the owning filesystem bundle and surfaced in the
 * chat view's Drive panel.
 *
 * GET returns one aggregate (memory + investigations + file map + plans +
 * tasks) so the panel needs a single call. Writes happen mostly through the
 * agent tools (`remember`, auto-captured investigations); these POST/PATCH/
 * DELETE endpoints back the panel's manual note management.
 *
 * v1 is poll-based (the panel refetches); SSE liveness on the coder bus can
 * be layered on later without changing this contract.
 */
export function mountCoderDriveRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/coder/sessions/:id/drive', async (c) => {
    const sessionId = parseSessionIdParam(c);
    try {
      return c.json(await deps.sessionStore.getDriveAggregate(sessionId));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Create / update a note (title is the upsert key).
  app.post('/api/coder/sessions/:id/drive/memory', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const body = await parseJsonBody<{ title: string; body: string; kind?: string; pinned?: boolean }>(c);
    if (!body.title || typeof body.body !== 'string') {
      return c.json({ error: 'title and body are required' }, 400);
    }
    try {
      const memory = await deps.sessionStore.rememberMemory(sessionId, {
        title: body.title,
        body: body.body,
        kind: body.kind,
        pinned: body.pinned,
      });
      return c.json({ ok: true, memory });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Pin / unpin a note. Scoped to the session in the path: a stale/foreign
  // memoryId can't pin another session's note (returns false → 404).
  app.patch('/api/coder/sessions/:id/drive/memory/:memoryId', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const memoryId = parseSessionRecordIdParam(c, 'memoryId');
    const body = await parseJsonBody<{ pinned: boolean }>(c);
    try {
      const ok = await deps.sessionStore.setSessionMemoryPinned(
        sessionId,
        memoryId,
        !!body.pinned,
      );
      if (!ok) return notFound(c, `Memory ${memoryId} not found`);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.delete('/api/coder/sessions/:id/drive/memory/:memoryId', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const memoryId = parseSessionRecordIdParam(c, 'memoryId');
    try {
      // Scoped delete — a foreign memoryId never deletes another session's note.
      const deleted = await deps.sessionStore.deleteSessionMemory(
        sessionId,
        memoryId,
      );
      if (!deleted) return notFound(c, `Memory ${memoryId} not found`);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
}
