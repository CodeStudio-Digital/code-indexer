import type { LspApi } from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import { defineLspRoute } from '@mcp/services/lsp/lsp-route.js';
import { clearAngularOverlayRoutingCache } from './angular-overlay-routing.js';
import { angularProfileTarget } from './angular-profile-routing.js';
import { publishDiagnostics, subscribeDiagnostics } from './diagnostics-hub.js';
import { changeDocWithSession, closeDoc, getDoc, openDoc } from './document-store.js';
import type { LspHandlerContext } from './handler-context.js';

type DocumentSyncHandlers = Pick<
  LspApi,
  'didOpen' | 'didChange' | 'didClose' | 'diagnosticsStream'
>;

export function createDocumentSyncHandlers(context: LspHandlerContext): DocumentSyncHandlers {
  const {
    db,
    requireProjectRoot,
    scheduleTsDiagnostics,
    scheduleSyntaxDiagnostics,
    clearDiagnosticTimers,
  } = context;

  return {
    async didOpen({ projectId, file, languageId, version, content, syncSessionId }) {
      const root = requireProjectRoot(projectId);
      const lang = languageId || languageIdForPath(file);
      const accepted = openDoc(projectId, file, lang, version, content, syncSessionId);
      if (!accepted) return { ok: true };
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      else {
        scheduleSyntaxDiagnostics(projectId, root, file, lang);
        if (process.env.MCP_LSP_WARM_ON_OPEN !== '0') {
          void context.lspManager.acquire(projectId, lang, 'open').catch(() => undefined);
        }
      }
      return { ok: true };
    },

    async didChange({ projectId, file, version, changes, syncSessionId }) {
      const root = requireProjectRoot(projectId);
      const changed = changeDocWithSession(projectId, file, version, changes, syncSessionId);
      if (changed === 'stale-session') return { ok: true };
      if (changed === 'resync') return { resync: true };
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      else {
        const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        scheduleSyntaxDiagnostics(projectId, root, file, languageId);
      }
      return { ok: true };
    },

    async didClose({ projectId, file, syncSessionId }) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      if (!closeDoc(projectId, file, syncSessionId)) return { ok: true };
      clearAngularOverlayRoutingCache(projectId, file);
      clearDiagnosticTimers(projectId, file);
      publishDiagnostics(projectId, { file, source: 'ts', diagnostics: [] });
      publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] });

      const angular = await angularProfileTarget(db, projectId, root, file, languageId);
      if (getDoc(projectId, file)) return { ok: true };
      const servers = [serverForLanguage(languageId), angular?.def];
      const cleared = new Set<string>();
      for (const server of servers) {
        if (!server || cleared.has(server.id)) continue;
        cleared.add(server.id);
        const routeId = server.id === angular?.def.id && angular.identity
          ? defineLspRoute(angular.identity).routeId
          : undefined;
        const source = (routeId
          ? `lsp:${server.id}:${routeId}`
          : `lsp:${server.id}`) as `lsp:${string}`;
        publishDiagnostics(projectId, { file, source, diagnostics: [] });
      }
      return { ok: true };
    },

    diagnosticsStream({ projectId }) {
      requireProjectRoot(projectId);
      return subscribeDiagnostics(projectId);
    },
  };
}
