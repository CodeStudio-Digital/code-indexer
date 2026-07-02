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
import { ApiError, type LspApi } from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import type { HandlerDeps } from '../types.js';
import { getDoc } from './document-store.js';
import { serverRename } from './server-backend-ops.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';

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
): Pick<LspApi, 'rename'> {
  const { db } = deps;

  return {
    async rename({ projectId, file, position, newName }) {
      if (process.env.MCP_EDITOR_RENAME === '0') {
        throw new ApiError(
          'feature_disabled', 503,
          'Rename is turned off on this install (MCP_EDITOR_RENAME=0).',
        );
      }
      const trimmed = typeof newName === 'string' ? newName.trim() : '';
      if (!trimmed) throw new ApiError('invalid_input', 400, 'newName must be a non-empty string');
      const root = helpers.requireProjectRoot(projectId);

      // TS/JS → in-process TS service via the executor (worker-backed when wired).
      if (isTsFile(file)) {
        const edits = await helpers.exec().tsRename({
          ...helpers.opCtx(projectId, root, file, position),
          newName: trimmed,
        });
        return { edits };
      }

      // Languages with a real server (php/python/json/css/html) → textDocument/rename.
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      if (serverForLanguage(lang)) {
        const edit = await serverRename(db, projectId, root, file, lang, position, trimmed);
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
  };
}
