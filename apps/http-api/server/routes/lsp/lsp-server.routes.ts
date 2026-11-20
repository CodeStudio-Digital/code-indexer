import type { HttpRouter } from '@mcp/shared/http/router.js';
import { streamSSE } from '@mcp/shared/http/sse.js';
import { createContext } from '@mcp/api-handlers/context.js';
import type { LspApi } from '@mcp/api-bus';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { mapLspApiError } from './lsp-http-utils.js';

interface AngularProfileOverrideBody {
  workspacePath: string;
  profileId: string | null;
}

interface RestartServerBody {
  routeId?: string;
  file?: string;
}

function isRestartServerBody(value: unknown): value is RestartServerBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (body.routeId === undefined || typeof body.routeId === 'string')
    && (body.file === undefined || typeof body.file === 'string');
}

function isAngularProfileOverrideBody(value: unknown): value is AngularProfileOverrideBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.workspacePath === 'string'
    && (body.profileId === null || typeof body.profileId === 'string');
}

/** Status, installation and lifecycle routes for host-managed LSP servers. */
export function mountLspServerRoutes(app: HttpRouter, deps: ServerDeps, h: LspApi): void {
  app.post('/api/lsp/:projectId/server-status', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ languageId: string; file?: string }>();
      return c.json(await h.serverStatus({ projectId, ...body }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.get('/api/lsp/servers', async (c) => {
    try { return c.json(await h.listServers(undefined, createContext())); }
    catch (err) { return mapLspApiError(c, err); }
  });

  app.get('/api/lsp/instances', async (c) => {
    try { return c.json(await h.instances(undefined, createContext())); }
    catch (err) { return mapLspApiError(c, err); }
  });

  app.delete('/api/lsp/servers/:serverId', async (c) => {
    try { return c.json(await h.removeServer({ serverId: c.req.param('serverId') }, createContext())); }
    catch (err) { return mapLspApiError(c, err); }
  });

  app.post('/api/lsp/:projectId/servers/:serverId/restart', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<unknown>().catch(() => null);
      if (!isRestartServerBody(body)) {
        return c.json({
          error: 'routeId and file must be strings when provided',
          code: 'bad_input',
        }, 400);
      }
      return c.json(await h.restartServer({
        projectId, serverId: c.req.param('serverId'), ...body,
      }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.post('/api/lsp/:projectId/language-level', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ languageId: 'php' | 'python'; level: string }>();
      return c.json(await h.setLanguageLevel({ projectId, ...body }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.get('/api/lsp/:projectId/language-levels', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      return c.json(await h.languageLevels({ projectId }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.get('/api/lsp/:projectId/angular-profile-overrides', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      return c.json(await h.angularProfileOverrides({ projectId }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.put('/api/lsp/:projectId/angular-profile-overrides', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<unknown>().catch(() => null);
      if (!isAngularProfileOverrideBody(body)) {
        return c.json({
          error: 'workspacePath must be a string and profileId must be a string or null',
          code: 'bad_input',
        }, 400);
      }
      return c.json(await h.setAngularProfileOverride({
        projectId,
        workspacePath: body.workspacePath,
        profileId: body.profileId,
      }, createContext()));
    } catch (err) { return mapLspApiError(c, err); }
  });

  app.get('/api/lsp/servers/:serverId/install/stream', async (c) => {
    const serverId = c.req.param('serverId');
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.installServerStream({ serverId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'install', data: JSON.stringify(frame) });
        }
      } finally { await stream.close(); }
    });
  });

  app.get('/api/lsp/:projectId/diagnostics/stream', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    if (!deps.db.getProject(projectId)) return c.json({ error: 'not_found' }, 404);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.diagnosticsStream({ projectId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'diagnostics', data: JSON.stringify(frame) });
        }
      } finally { await stream.close(); }
    });
  });

  app.get('/api/lsp/:projectId/server-status/stream', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    if (!deps.db.getProject(projectId)) return c.json({ error: 'not_found' }, 404);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.serverStatusStream({ projectId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'serverStatus', data: JSON.stringify(frame) });
        }
      } finally { await stream.close(); }
    });
  });
}
