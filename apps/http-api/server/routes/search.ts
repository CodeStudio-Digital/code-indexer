import type { HttpContext, HttpRouter } from '@mcp/shared/http/router.js';
import { createSearchHandlers, createContext } from '@mcp/api-handlers';
import { ApiError } from '@mcp/api-bus';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import type { ServerDeps } from '../deps.js';
import { searchConsumer, validateTelemetryScope } from '../index-search-service.js';
import { parseIdParam, parseIntQuery } from './_helpers.js';

function mapApiError(c: HttpContext, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

async function validatedTelemetryScope(
  c: HttpContext,
  deps: ServerDeps,
  projectId: number,
): Promise<{ sessionId?: string; companySessionId?: string } | undefined> {
  return validateTelemetryScope(deps, projectId, {
    sessionId: c.req.header('x-mcp-session-id'),
    companySessionId: c.req.header('x-mcp-company-session-id'),
  });
}

export function mountSearchRoutes(app: HttpRouter, deps: ServerDeps): void {
  const h = createSearchHandlers(deps);

  app.get('/api/projects/:id/search', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const mode = c.req.query('mode') as SearchMode | undefined;
      const type = c.req.query('type') as SearchType | undefined;
      const limit = parseIntQuery(c, 'limit', 20);
      const supersessionKey = c.req.query('supersessionKey');
      const bypassCache = c.req.query('bypassCache') === '1';
      const consumer = searchConsumer(c.req.query('consumer'));
      const telemetryScope = await validatedTelemetryScope(c, deps, projectId);
      return c.json(await h.project(
        {
          projectId,
          query,
          mode,
          type,
          limit,
          supersessionKey,
          bypassCache,
          consumer,
        },
        createContext({
          signal: c.req.raw.signal,
          clientInfo: { sourceType: 'http' },
          telemetryScope,
        }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/search/outcome', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<{
        requestId?: unknown;
        semanticWin?: unknown;
      }>();
      return c.json(await h.outcome({
        projectId,
        requestId: String(body.requestId ?? ''),
        semanticWin: body.semanticWin === true,
      }, createContext({
        signal: c.req.raw.signal,
        clientInfo: { sourceType: 'http' },
      })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/search', async (c) => {
    try {
      const query = c.req.query('q') ?? '';
      const mode = c.req.query('mode') as SearchMode | undefined;
      const type = c.req.query('type') as SearchType | undefined;
      const limit = parseIntQuery(c, 'limit', 20);
      const supersessionKey = c.req.query('supersessionKey');
      return c.json(await h.global(
        { query, mode, type, limit, supersessionKey },
        createContext({ signal: c.req.raw.signal, clientInfo: { sourceType: 'http' } }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Search Everywhere — thin FTS tabs (Symbols / Text), <20ms targets. */
  app.get('/api/projects/:id/search/symbols', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const limit = parseIntQuery(c, 'limit', 50);
      return c.json(await h.symbols(
        { projectId, query, limit },
        createContext({ signal: c.req.raw.signal, clientInfo: { sourceType: 'http' } }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/search/text', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const query = c.req.query('q') ?? '';
      const limit = parseIntQuery(c, 'limit', 50);
      return c.json(await h.text(
        { projectId, query, limit },
        createContext({ signal: c.req.raw.signal, clientInfo: { sourceType: 'http' } }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Find in Files — literal/regex grep with per-match positions.
  app.post('/api/projects/:id/search/grep', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<Record<string, unknown>>();
      return c.json(await h.grep({ ...body, projectId } as never, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Replace in Files — applies the matcher and writes changed files.
  app.post('/api/projects/:id/search/replace', async (c) => {
    try {
      const projectId = parseIdParam(c);
      const body = await c.req.json<Record<string, unknown>>();
      return c.json(await h.replace({ ...body, projectId } as never, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
