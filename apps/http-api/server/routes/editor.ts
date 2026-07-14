import type { Hono } from 'hono';
import { createEditorHandlers, createContext } from '@mcp/api-handlers';
import type { EditorCancelInput, EditorCompleteInput, EditorDeliveryInput, EditorFeedbackInput, EditorProbeInput } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';

/**
 * Editor AI routes (browser-dev / headless server). On Electron the same
 * handlers mount over IPC via createHandlers — these stay thin adapters.
 * The handler itself never throws (fail-open by contract), so no error
 * mapping beyond a defensive 500.
 */
export function mountEditorRoutes(app: Hono, deps: ServerDeps): void {
  const h = createEditorHandlers(deps);

  app.post('/api/editor/resolve-config', async (c) => {
    try {
      const body = await c.req.json() as { projectId: number; file: string };
      return c.json(await h.resolveConfig(body, createContext()));
    } catch (error) {
      return c.json({ settings: {}, sources: [], error: error instanceof Error ? error.message : 'bad request' }, 400);
    }
  });

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

  app.post('/api/editor/delivery', async (c) => {
    try {
      const body = (await c.req.json()) as EditorDeliveryInput;
      return c.json(await h.delivery(body, createContext()));
    } catch { return c.json({ ok: false }, 400); }
  });

  app.post('/api/editor/cancel', async (c) => {
    try {
      const body = (await c.req.json()) as EditorCancelInput;
      return c.json(await h.cancel(body, createContext()));
    } catch { return c.json({ ok: false }, 400); }
  });

  app.post('/api/editor/probe', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as EditorProbeInput;
      return c.json(await h.probe(body, createContext()));
    } catch { return c.json({ ok: false, samples: [], latency: { p50: null, p90: null }, verifiedForAutomatic: false }, 500); }
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
