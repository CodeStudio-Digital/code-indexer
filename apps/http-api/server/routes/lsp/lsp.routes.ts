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

import type { Hono } from 'hono';
import { createLspHandlers, createContext } from '@mcp/api-handlers';
import { type CodeActionDTO, type DocChange, type Position } from '@mcp/api-bus';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam } from '../_helpers.js';
import { mapLspApiError as mapApiError } from './lsp-http-utils.js';
import { mountLspServerRoutes } from './lsp-server.routes.js';

interface PositionBody {
  file: string;
  position: Position;
  content?: string;
  context?: { triggerKind: number; triggerCharacter?: string };
}

export function mountLspRoutes(app: Hono, deps: ServerDeps): void {
  const h = createLspHandlers(deps);
  mountLspServerRoutes(app, deps, h);

  // ─── Stateful document sync ───────────────────────────────────────
  app.post('/api/lsp/:projectId/did-open', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; languageId: string; version: number; content: string; syncSessionId: string }>();
      return c.json(await h.didOpen({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/did-change', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; version: number; changes: DocChange[]; syncSessionId: string }>();
      return c.json(await h.didChange({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/did-close', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; syncSessionId: string }>();
      return c.json(await h.didClose({ projectId, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/completion', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.completion({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/code-actions', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; range: { start: Position; end: Position } }>();
      return c.json(await h.codeActions({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/resolve-completion', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; item: unknown }>();
      return c.json(await h.resolveCompletion({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/resolve-code-action', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; action: CodeActionDTO }>();
      return c.json(await h.resolveCodeAction({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
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
      return c.json(await h.hover({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/definition', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.definition({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/type-definition', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position }>();
      return c.json(await h.typeDefinition(
        { projectId, ...body },
        createContext({ signal: c.req.raw.signal }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/folding-ranges', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.foldingRanges(
        { projectId, ...body },
        createContext({ signal: c.req.raw.signal }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/inlay-hints', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{
        file: string;
        range: { start: Position; end: Position };
      }>();
      return c.json(await h.inlayHints(
        { projectId, ...body },
        createContext({ signal: c.req.raw.signal }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/linked-editing-ranges', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position }>();
      return c.json(await h.linkedEditingRanges(
        { projectId, ...body },
        createContext({ signal: c.req.raw.signal }),
      ));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/references', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.references({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/rename', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position; newName: string }>();
      return c.json(await h.rename({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/signature-help', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string; position: Position }>();
      return c.json(await h.signatureHelp({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/document-symbols', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.documentSymbols({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
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
      return c.json(await h.formatting({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/organize-imports', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<{ file: string }>();
      return c.json(await h.organizeImports({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/lsp/:projectId/implementation', async (c) => {
    try {
      const projectId = parseIdParam(c, 'projectId');
      const body = await c.req.json<PositionBody>();
      return c.json(await h.implementation({ projectId, ...body }, createContext({ signal: c.req.raw.signal })));
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
