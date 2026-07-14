/**
 * Hono adapter for the project-local git surface
 * (apps/http-api/server/routes/project-git.ts → @mcp/api-handlers/projectGit).
 * Distinct from /api/workspace/git which targets sandbox containers.
 */

import type { Context, Hono } from 'hono';
import { createProjectGitHandlers } from '@mcp/api-handlers/projectGit/index.js';
import { createContext } from '@mcp/api-handlers/context.js';
import { PROJECT_GIT_RPC_METHODS } from '@mcp/api-handlers/projectGit/guard.js';
import { ApiError } from '@mcp/api-bus';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';
import { requireLocalRequest } from '../middleware/local-origin.js';

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountProjectGitRoutes(app: Hono, deps: ServerDeps): void {
  const h = createProjectGitHandlers(deps);
  const rpcMethods = new Set<string>(PROJECT_GIT_RPC_METHODS);

  app.use('/api/projects/:id/git/*', requireLocalRequest);

  app.post('/api/projects/:id/git/rpc/:method', async (c) => {
    try {
      const method = c.req.param('method');
      if (!rpcMethods.has(method)) return c.json({ error: 'git_method_not_found' }, 404);
      const raw = await c.req.json<unknown>();
      const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const fn = h[method as keyof typeof h] as unknown as (
        input: Record<string, unknown>,
        ctx: ReturnType<typeof createContext>,
      ) => Promise<unknown>;
      return c.json(await fn({ ...body, projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/git/status', async (c) => {
    try {
      const includeFilesParam = c.req.query('includeFiles')?.toLowerCase();
      const includeFiles =
        includeFilesParam !== '0' &&
        includeFilesParam !== 'false' &&
        c.req.query('summary') !== '1';
      return c.json(await h.status({ projectId: parseIdParam(c), includeFiles }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/diff', async (c) => {
    try {
      const body = await c.req.json<{ path?: string; staged?: boolean }>();
      return c.json(
        await h.diff({ projectId: parseIdParam(c), path: body.path, staged: body.staged }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/git/log', async (c) => {
    try {
      const limit = Number(c.req.query('limit') ?? 30);
      const skip = Number(c.req.query('skip') ?? 0);
      const path = c.req.query('path') || undefined;
      const branch = c.req.query('branch') || undefined;
      const all = c.req.query('all') === 'true';
      return c.json(await h.log({ projectId: parseIdParam(c), limit, skip, path, branch, all }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/stage', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(await h.stage({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/unstage', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(
        await h.unstage({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/discard', async (c) => {
    try {
      const body = await c.req.json<{ paths: string[] }>();
      return c.json(
        await h.discard({ projectId: parseIdParam(c), paths: body.paths ?? [] }, createContext()),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/commit', async (c) => {
    try {
      const body = await c.req.json<{ message: string; amend?: boolean }>();
      if (!body.message) return c.json({ error: 'message required' }, 400);
      return c.json(
        await h.commit(
          { projectId: parseIdParam(c), message: body.message, amend: body.amend },
          createContext(),
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/git/branches', async (c) => {
    try {
      return c.json(await h.branchList({ projectId: parseIdParam(c) }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/git/checkout', async (c) => {
    try {
      const body = await c.req.json<{ name: string; create?: boolean }>();
      if (!body.name) return c.json({ error: 'name required' }, 400);
      return c.json(
        await h.branchCheckout(
          { projectId: parseIdParam(c), name: body.name, create: body.create },
          createContext(),
        ),
      );
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
