/**
 * Routes — publicação do App Studio na conta Cloudflare do usuário.
 *
 *   GET  /api/app-studio/cf/whoami?session_id=N  → { logged_in, email, accounts }
 *   POST /api/app-studio/login                   → SSE (wrangler login OAuth)
 *        body opcional { session_id } — usa o wrangler pinado do workspace
 *   POST /api/app-studio/apps/:id/publish        → SSE (auth→db→migrate→
 *        build→deploy→health→persist)
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAppLaunchStream, runWranglerLoginStream, runWranglerWhoami } from '@mcp/api-handlers';
import { parseIdParam } from '../_helpers.js';
import { pumpScaffoldSSE } from '../scaffold-sse-pump.js';
import type { ServerDeps } from '../../deps.js';

export function mountAppStudioLaunchRoutes(app: Hono, deps: ServerDeps): void {
  /** cwd preferencial p/ spawns do wrangler: o workspace da sessão. */
  function workspaceOf(sessionId: number | null): string | null {
    if (sessionId == null || !Number.isFinite(sessionId)) return null;
    const session = deps.appStudioStore.getSession(sessionId);
    if (!session) return null;
    return deps.db.getProject(session.project_id)?.root_path ?? null;
  }

  app.get('/api/app-studio/apps/:id/publish', async (c) => {
    const sessionId = parseIdParam(c);
    const who = await runWranglerWhoami(workspaceOf(sessionId));
    return c.json(who);
  });

  app.post('/api/app-studio/apps/:id/publish/login', async (c) => {
    const sessionId = parseIdParam(c);
    const cwd = workspaceOf(sessionId);
    const signal = c.req.raw.signal;
    return streamSSE(c, (stream) =>
      pumpScaffoldSSE(stream, (emit) => runWranglerLoginStream(emit, { cwd, signal })),
    );
  });

  app.post('/api/app-studio/apps/:id/publish', (c) => {
    const id = parseIdParam(c);
    const signal = c.req.raw.signal;
    return streamSSE(c, (stream) =>
      pumpScaffoldSSE(stream, (emit) => runAppLaunchStream(deps, id, emit, signal)),
    );
  });
}
