/**
 * Editor refactor handlers — merged by spread into the object
 * `createLspHandlers` returns (index.ts), so the router file stays a
 * dispatch table. Routing policy for rename:
 *
 *   ts/js                    → TS service (findRenameLocations) via executor
 *   php/python/json/css/html → the language server (textDocument/rename)
 *   anything else            → 422 — the structural index is name-based and
 *                              deliberately NOT used (unsafe for rename).
 *
 * Kill switch: MCP_EDITOR_RENAME=0 → friendly 503.
 * All cross-cutting state stays in module singletons elsewhere — this
 * factory holds none (createLspHandlers is instantiated 2-3× on Electron).
 */
import { readFileSync } from 'node:fs';
import { ApiError, type LspApi } from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import {
  serverForLanguage,
} from '@mcp/services/lsp/server-registry.js';
import type { HandlerDeps } from '../types.js';
import { getDoc } from './document-store.js';
import {
  serverDocumentSymbols,
  serverFormatting,
  serverImplementation,
  serverOrganizeImports,
  serverRename,
  serverSignatureHelp,
} from './server-backend-ops.js';
import { fallbackSignatureHelp } from './fallback-signature.js';
import { fallbackDocumentSymbols } from './fallback-document-symbols.js';
import { fallbackImplementation } from './fallback-implementation.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';
import {
  shouldUseAngularInteractiveOverlay,
} from './angular-overlay-routing.js';
import {
  angularProfileTarget,
  type AngularProfileTarget,
} from './angular-profile-routing.js';

/** Closures shared with createLspHandlers (index.ts) — no duplicated logic. */
export interface EditorOpsHelpers {
  requireProjectRoot(projectId: number): string;
  opCtx(
    projectId: number,
    root: string,
    file: string,
    position?: { line: number; column: number },
  ): LspOpCtx;
  exec(): LspBackendExecutor;
}

export function createEditorOpsHandlers(
  deps: HandlerDeps,
  helpers: EditorOpsHelpers,
): Pick<LspApi, 'rename' | 'signatureHelp' | 'documentSymbols' | 'formatting' | 'organizeImports' | 'implementation'> {
  const { db } = deps;

  /** Live buffer when open; disk otherwise (fallback ops need raw content). */
  const contentFor = (projectId: number, root: string, file: string): string | null => {
    const live = getDoc(projectId, file);
    if (live) return live.content;
    try { return readFileSync(relToAbsCanonical(root, file), 'utf-8'); } catch { return null; }
  };

  const angularOverlay = (
    projectId: number,
    root: string,
    file: string,
    languageId: string,
  ): AngularProfileTarget | undefined => angularProfileTarget(db, projectId, root, file, languageId);

  const angularOverlayAt = (
    projectId: number,
    root: string,
    file: string,
    languageId: string,
    position: { line: number; column: number },
  ): AngularProfileTarget | undefined => {
    const overlay = angularOverlay(projectId, root, file, languageId);
    if (!overlay) return undefined;
    return shouldUseAngularInteractiveOverlay({
      projectId,
      file,
      languageId,
      content: contentFor(projectId, root, file),
      position,
    }) ? overlay : undefined;
  };

  return {
    async signatureHelp({ projectId, file, position }, ctx) {
      const root = helpers.requireProjectRoot(projectId);
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayAt(projectId, root, file, lang, position);
      if (angular) {
        const viaAngular = await serverSignatureHelp(
          db, projectId, root, file, lang, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return null;
        if (viaAngular) return viaAngular;
      }
      if (isTsFile(file)) {
        return helpers.exec().tsSignatureHelp(helpers.opCtx(projectId, root, file, position));
      }
      if (serverForLanguage(lang)) {
        const viaServer = await serverSignatureHelp(db, projectId, root, file, lang, position, ctx.signal);
        if (ctx.signal.aborted) return null;
        if (viaServer) return viaServer;
      }
      const content = contentFor(projectId, root, file);
      return content ? fallbackSignatureHelp(db, projectId, content, position) : null;
    },

    async documentSymbols({ projectId, file }, ctx) {
      const root = helpers.requireProjectRoot(projectId);
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlay(projectId, root, file, lang);
      if (angular) {
        const viaAngular = await serverDocumentSymbols(
          db, projectId, root, file, lang, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (isTsFile(file)) {
        return helpers.exec().tsDocumentSymbols(helpers.opCtx(projectId, root, file));
      }
      if (serverForLanguage(lang)) {
        const viaServer = await serverDocumentSymbols(db, projectId, root, file, lang, ctx.signal);
        if (ctx.signal.aborted) return [];
        if (viaServer && viaServer.length > 0) return viaServer;
      }
      return fallbackDocumentSymbols(db, projectId, file);
    },
    async rename({ projectId, file, position, newName }, ctx) {
      if (process.env.MCP_EDITOR_RENAME === '0') {
        throw new ApiError(
          'feature_disabled', 503,
          'Rename is turned off on this install (MCP_EDITOR_RENAME=0).',
        );
      }
      const trimmed = typeof newName === 'string' ? newName.trim() : '';
      if (!trimmed) throw new ApiError('invalid_input', 400, 'newName must be a non-empty string');
      const root = helpers.requireProjectRoot(projectId);

      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayAt(projectId, root, file, lang, position);
      if (angular) {
        const edit = await serverRename(
          db, projectId, root, file, lang, position, trimmed, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return { edits: [] };
        if (edit && Object.keys(edit.changes).length > 0) {
          return {
            edits: Object.entries(edit.changes).flatMap(([f, fileEdits]) =>
              fileEdits.map((e) => ({ file: f, range: e.range, newText: e.newText })),
            ),
          };
        }
      }

      // TS/JS → in-process TS service via the executor (worker-backed when wired).
      if (isTsFile(file)) {
        const edits = await helpers.exec().tsRename({
          ...helpers.opCtx(projectId, root, file, position),
          newName: trimmed,
        });
        return { edits };
      }

      // Languages with a real server (php/python/json/css/html) → textDocument/rename.
      if (serverForLanguage(lang)) {
        const edit = await serverRename(db, projectId, root, file, lang, position, trimmed, ctx.signal);
        if (!edit) {
          throw new ApiError(
            'server_unavailable', 503,
            `The ${lang} language server could not answer the rename — ` +
            'check it is installed and ready (language chip in the status bar).',
          );
        }
        return {
          edits: Object.entries(edit.changes).flatMap(([f, fileEdits]) =>
            fileEdits.map((e) => ({ file: f, range: e.range, newText: e.newText })),
          ),
        };
      }

      // No index fallback ON PURPOSE: name-based matching has no scope
      // awareness and would corrupt unrelated identifiers.
      throw new ApiError(
        'unsupported_language', 422,
        'Rename requires a language server or TypeScript — the structural index ' +
        'is name-based and unsafe for rename.',
      );
    },

    async formatting({ projectId, file, range, options }, ctx) {
      // NOT routed for ts/js/json/css/html on purpose — Monaco's built-in
      // workers already format those client-side; the provider only registers
      // for server languages (php today).
      const root = helpers.requireProjectRoot(projectId);
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const formatterServerId = lang === 'python' ? 'ruff' : undefined;
      if (!serverForLanguage(lang) && lang !== 'python') {
        throw new ApiError(
          'unsupported_language', 422,
          `No formatter for ${lang} files — formatting needs a language server ` +
          '(TS/JS/JSON/CSS/HTML format via the editor’s built-in workers).',
        );
      }
      const edits = await serverFormatting(db, projectId, root, file, lang, options, range, formatterServerId, ctx.signal);
      if (!edits) {
        throw new ApiError(
          'server_unavailable', 503,
          `The ${lang === 'python' ? 'Ruff formatter' : `${lang} language server`} could not format the file — ` +
          'check it is installed and ready in Settings > Editor > Autocomplete.',
        );
      }
      return edits;
    },

    async organizeImports({ projectId, file }, ctx) {
      const root = helpers.requireProjectRoot(projectId);
      // TS/JS → the TS service's organizeImports via the executor.
      if (isTsFile(file)) {
        const edits = await helpers.exec().tsOrganizeImports(helpers.opCtx(projectId, root, file));
        return { edits: edits.map((e) => ({ file: e.file, range: e.range, newText: e.newText })) };
      }
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      if (serverForLanguage(lang)) {
        const edits = await serverOrganizeImports(db, projectId, root, file, lang, ctx.signal);
        if (edits === null) {
          throw new ApiError(
            'server_unavailable', 503,
            `The ${lang} language server could not organize imports — ` +
            'check it is installed and ready (language chip in the status bar).',
          );
        }
        // Server reachable but offers no source.organizeImports action
        // (e.g. Intelephense free) — soft "not supported", not an error.
        if (edits.length === 0) {
          return {
            edits: [],
            applied: false as const,
            reason: `organize imports is not supported by the ${lang} language server`,
          };
        }
        return { edits };
      }
      throw new ApiError(
        'unsupported_language', 422,
        'Organize imports requires TypeScript or a language server for this file type.',
      );
    },

    async implementation({ projectId, file, position }, ctx) {
      const root = helpers.requireProjectRoot(projectId);
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayAt(projectId, root, file, lang, position);
      if (angular) {
        const viaAngular = await serverImplementation(
          db, projectId, root, file, lang, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (isTsFile(file)) {
        const { targets } = await helpers.exec().tsImplementation(
          helpers.opCtx(projectId, root, file, position),
        );
        return targets.map((t) => ({
          file: t.file,
          range: { start: { line: t.line, column: t.column }, end: { line: t.line, column: t.column } },
        }));
      }
      if (serverForLanguage(lang)) {
        const viaServer = await serverImplementation(db, projectId, root, file, lang, position, ctx.signal);
        if (ctx.signal.aborted) return [];
        if (viaServer && viaServer.length > 0) return viaServer;
      }
      // Structural-index fallback: implementors of an interface + subclasses
      // of a base class, by the word under the cursor (absolute paths, like
      // fallbackDefinition).
      const content = contentFor(projectId, root, file);
      return content ? fallbackImplementation(db, projectId, root, content, position) : [];
    },
  };
}
