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
import { streamSSE } from 'hono/streaming';
import { createLspHandlers, createContext } from '@mcp/api-handlers';
import { ApiError, type CodeActionDTO, type DocChange, type Position } from '@mcp/api-bus';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';

interface PositionBody {
  file: string;
  position: Position;
  content?: string;
  context?: { triggerKind: number; triggerCharacter?: string };
}

function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}

export function mountLspRoutes(app: Hono, deps: ServerDeps): void {
  const h = createLspHandlers(deps);

  // ─── Stateful document sync ───────────────────────────────────────
  app.post('/api/lsp/:projectId/did-open', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; languageId: string; version: number; content: string }>();
      return c.json(await h.didOpen({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/did-change', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; version: number; changes: DocChange[] }>();
      return c.json(await h.didChange({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/did-close', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.didClose({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // ─── External LSP servers (status / catalog / install / lifecycle) ──
  app.post('/api/lsp/:projectId/server-status', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ languageId: string }>();
      return c.json(await h.serverStatus({ projectId, languageId: body.languageId }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/lsp/servers', async (c) => {
    try {
      return c.json(await h.listServers(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/lsp/instances', async (c) => {
    try {
      return c.json(await h.instances(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.delete('/api/lsp/servers/:serverId', async (c) => {
    try {
      return c.json(await h.removeServer({ serverId: c.req.param('serverId') }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/servers/:serverId/restart', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      return c.json(await h.restartServer({ projectId, serverId: c.req.param('serverId') }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/language-level', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ languageId: 'php' | 'python'; level: string }>();
      return c.json(await h.setLanguageLevel({ projectId, languageId: body.languageId, level: body.level }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/lsp/:projectId/language-levels', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      return c.json(await h.languageLevels({ projectId }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  /** Consent-gated install with streamed progress (SSE; MessagePort on Electron). */
  app.get('/api/lsp/servers/:serverId/install/stream', async (c) => {
    const serverId = c.req.param('serverId');
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.installServerStream({ serverId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'install', data: JSON.stringify(frame) });
        }
      } finally {
        await stream.close();
      }
    });
  });

  /** Diagnostics push (browser-dev parity for the Electron MessagePort stream). */
  app.get('/api/lsp/:projectId/diagnostics/stream', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    if (!deps.db.getProject(projectId)) return c.json({ error: 'not_found' }, 404);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.diagnosticsStream({ projectId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'diagnostics', data: JSON.stringify(frame) });
        }
      } finally {
        await stream.close();
      }
    });
  });

  /** Server-status push (live language chip) — browser-dev parity. */
  app.get('/api/lsp/:projectId/server-status/stream', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    if (!deps.db.getProject(projectId)) return c.json({ error: 'not_found' }, 404);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.serverStatusStream({ projectId }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'serverStatus', data: JSON.stringify(frame) });
        }
      } finally {
        await stream.close();
      }
    });
  });

  app.post('/api/lsp/:projectId/completion', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.completion({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/code-actions', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; range: { start: Position; end: Position } }>();
      return c.json(await h.codeActions({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/resolve-completion', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; item: unknown }>();
      return c.json(await h.resolveCompletion({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/resolve-code-action', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; action: CodeActionDTO }>();
      return c.json(await h.resolveCodeAction({ projectId, ...body }, createContext()));
    } catch (err) { return mapApiError(c, err); }
  });

  app.post('/api/lsp/:projectId/execute-code-action', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ action: CodeActionDTO }>();
      return c.json(await h.executeCodeAction({ projectId, ...body }, createContext()));
    } catch (err) { return mapApiError(c, err); }
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

  app.post('/api/lsp/:projectId/rename', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position; newName: string }>();
      return c.json(await h.rename({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/signature-help', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position }>();
      return c.json(await h.signatureHelp({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/document-symbols', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.documentSymbols({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/formatting', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{
        file: string;
        range?: { start: Position; end: Position };
        options: { tabSize: number; insertSpaces: boolean };
      }>();
      return c.json(await h.formatting({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/organize-imports', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.organizeImports({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/implementation', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.implementation({ projectId, ...body }, createContext()));
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
