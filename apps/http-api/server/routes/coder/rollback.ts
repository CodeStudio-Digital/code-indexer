/**
 * Rollback-to-message — POST /api/coder/sessions/:id/rollback-to-message.
 *
 * Destructive, in-place counterpart to "Fork from here": deletes the target
 * user message AND everything after it, then returns the message's text +
 * attachments so the dashboard can re-seed the composer for editing & re-send.
 *
 * Mirrors the concurrency handling of the manual "summarize & clear" route
 * (the other destructive session mutation): serialize against the run-setup
 * path with the per-session lock, refuse while a run is active, and drop the
 * (ended) bus afterwards so the next POST /messages rebuilds a fresh runner
 * from the truncated DB.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { withSessionLock } from './sessionLock.js';

export function mountCoderRollbackRoute(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns } = runtime;

  app.post('/api/coder/sessions/:id/rollback-to-message', async (c) => {
    const id = parseIdParam(c);
    const session = sessionStore.getSession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{ message_id?: number }>(c);
    const messageId = body.message_id;
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) {
      return c.json({ error: 'message_id:number required' }, 400);
    }

    return withSessionLock(id, async () => {
      const bus = activeRuns.get(id);
      if (bus && !bus.ended) {
        return c.json(
          { error: 'a run is active — stop it before rolling back', code: 'run_active' },
          409,
        );
      }

      let result;
      try {
        result = sessionStore.rollbackSessionToMessage(id, messageId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }

      // Drop any lingering (ended) bus so the next /messages POST builds a
      // fresh runner that reloads only the surviving transcript. The Proxy
      // also evicts the pooled worker for this session.
      activeRuns.delete(id);

      return c.json({ ok: true, ...result });
    });
  });
}
