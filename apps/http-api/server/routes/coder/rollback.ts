/**
 * Rollback-to-sequence — POST /api/coder/sessions/:id/rollback-to-message.
 *
 * In-place counterpart to "Fork from here": appends a rollback marker that
 * projects away the target user message and everything after it, then returns
 * its text + attachments for editing and re-send. conversation.jsonl remains
 * append-only.
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
import { parseSessionIdParam, parseJsonBody, parseSeqValue, notFound } from '../_helpers.js';
import { withSessionLock } from './sessionLock.js';

export function mountCoderRollbackRoute(
  app: Hono,
  deps: ServerDeps,
  runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;
  const { activeRuns } = runtime;

  app.post('/api/coder/sessions/:id/rollback-to-message', async (c) => {
    const id = parseSessionIdParam(c);
    const session = await sessionStore.getSession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{ seq?: number }>(c);
    const seq = parseSeqValue(body.seq);

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
        result = await sessionStore.rollbackSessionToSeq(id, seq);
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
