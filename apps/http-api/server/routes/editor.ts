import type { Hono } from 'hono';
import { createEditorHandlers, createContext } from '@mcp/api-handlers';
import type { EditorCompleteInput, EditorFeedbackInput } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';

/**
 * Editor AI routes (browser-dev / headless server). On Electron the same
 * handlers mount over IPC via createHandlers — these stay thin adapters.
 * The handler itself never throws (fail-open by contract), so no error
 * mapping beyond a defensive 500.
 */
export function mountEditorRoutes(app: Hono, deps: ServerDeps): void {
  const h = createEditorHandlers(deps);

  app.post('/api/editor/complete', async (c) => {
    try {
      const body = (await c.req.json()) as EditorCompleteInput;
      return c.json(await h.complete(body, createContext()));
    } catch {
      return c.json({ status: 'provider_error', message: 'bad request' }, 400);
    }
  });

  app.post('/api/editor/feedback', async (c) => {
    try {
      const body = (await c.req.json()) as EditorFeedbackInput;
      return c.json(await h.feedback(body, createContext()));
    } catch {
      return c.json({ ok: false }, 400);
    }
  });

  app.post('/api/editor/stats', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { days?: number };
      return c.json(await h.stats(body, createContext()));
    } catch {
      return c.json({ configured: false }, 500);
    }
  });
}
