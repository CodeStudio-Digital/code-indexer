/**
 * LSP HTTP routes — POST endpoints that wrap the in-process TypeScript
 * language service for the Monaco editor in the IDE workspace.
 *
 * Latency target: <50 ms local round-trip. POST (not WS) is intentional —
 * Monaco debounces calls already (~300 ms for completion, ~1 s for
 * diagnostics), so the request rate is low and per-call latency dominates
 * over reconnection complexity.
 *
 * The Electron transport mounts the same handler in-process via IPC,
 * skipping the HTTP hop entirely. This file exists for the browser dev
 * mode (`pnpm dev`) and external tooling.
 */

import type { Context, Hono } from 'hono';
import { createLspHandlers, createContext } from '@mcp/api-handlers';
import { ApiError, type Position } from '@mcp/api-bus';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';

interface PositionBody {
  file: string;
  position: Position;
}

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountLspRoutes(app: Hono, deps: ServerDeps): void {
  const h = createLspHandlers(deps);

  app.post('/api/lsp/:projectId/completion', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.completion({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/hover', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.hover({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/definition', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.definition({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/references', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.references({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/diagnostics', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file?: string }>();
      return c.json(await h.diagnostics({ projectId, file: body.file }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });
}
