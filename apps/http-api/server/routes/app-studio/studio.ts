/**
 * Route — App Studio creation.
 *
 *   POST /api/app-studio/apps   (JSON → SSE)
 *
 * Body: { name, app_slug?, provider, model }. Responde com o mesmo stream
 * `start/phase/log/done/error` do New Project wizard (pumpScaffoldSSE
 * garante o flush do `done` antes de fechar); o `done` carrega
 * `{ project, app_session, master_session_id, company_session_id }`.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAppStudioScaffoldStream, type AppStudioCreateInput } from '@mcp/api-handlers';
import type { ServerDeps } from '../../deps.js';
import { pumpScaffoldSSE } from '../scaffold-sse-pump.js';

export function mountAppStudioCreateRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/app-studio/apps', async (c) => {
    let body: AppStudioCreateInput;
    try {
      body = (await c.req.json()) as AppStudioCreateInput;
    } catch (e) {
      return c.json({ error: `Failed to parse JSON body: ${(e as Error).message}` }, 400);
    }
    const signal = c.req.raw.signal;
    return streamSSE(c, (stream) =>
      pumpScaffoldSSE(stream, (emit) => runAppStudioScaffoldStream(deps, body, emit, signal)),
    );
  });
}
