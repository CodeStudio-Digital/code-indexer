import { type CodeActionDTO, type DiagnosticItem, type LspApi } from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import { angularProfileTarget } from './angular-profile-routing.js';
import { getDoc } from './document-store.js';
import type { LspHandlerContext } from './handler-context.js';
import {
  serverCodeActions,
  serverExecuteCodeAction,
  serverResolveCodeAction,
  serverSemanticTokens,
} from './server-backend.js';
import {
  serverFoldingRanges,
  serverInlayHints,
  serverLinkedEditingRanges,
  serverTypeDefinition,
} from './server-backend-ops.js';

type LanguageFeatureHandlers = Pick<
  LspApi,
  | 'typeDefinition'
  | 'foldingRanges'
  | 'inlayHints'
  | 'linkedEditingRanges'
  | 'diagnostics'
  | 'semanticTokens'
  | 'codeActions'
  | 'resolveCodeAction'
  | 'executeCodeAction'
>;

function mergeCodeActions(preferred: CodeActionDTO[], fallback: CodeActionDTO[]): CodeActionDTO[] {
  const seen = new Set(preferred.map((action) => `${action.title}\0${action.kind ?? ''}`));
  const merged = [...preferred];
  for (const action of fallback) {
    const key = `${action.title}\0${action.kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
  }
  return merged;
}

export function createLanguageFeatureHandlers(
  context: LspHandlerContext,
): LanguageFeatureHandlers {
  const {
    db,
    requireProjectRoot,
    angularOverlayForPosition,
    angularOverlayForRange,
    exec,
    opCtx,
  } = context;

  return {
    async typeDefinition({ projectId, file, position }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position);
      if (angular) {
        const viaAngular = await serverTypeDefinition(
          db, projectId, root, file, languageId, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (isTsFile(file)) return [];
      const primary = serverForLanguage(languageId);
      if (!primary || primary.id === angular?.def.id) return [];
      return await serverTypeDefinition(
        db, projectId, root, file, languageId, position, ctx.signal, primary.id,
      ) ?? [];
    },

    async foldingRanges({ projectId, file }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularProfileTarget(db, projectId, root, file, languageId);
      if (angular) {
        const viaAngular = await serverFoldingRanges(
          db, projectId, root, file, languageId, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      const primary = serverForLanguage(languageId);
      if (!primary || primary.id === angular?.def.id) return [];
      return await serverFoldingRanges(
        db, projectId, root, file, languageId, ctx.signal, primary.id,
      ) ?? [];
    },

    async inlayHints({ projectId, file, range }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForRange(projectId, root, file, languageId, range);
      if (angular) {
        const viaAngular = await serverInlayHints(
          db, projectId, root, file, languageId, range, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return [];
        if (viaAngular && viaAngular.length > 0) return viaAngular;
      }
      if (isTsFile(file)) return [];
      const primary = serverForLanguage(languageId);
      if (!primary || primary.id === angular?.def.id) return [];
      return await serverInlayHints(
        db, projectId, root, file, languageId, range, ctx.signal, primary.id,
      ) ?? [];
    },

    async linkedEditingRanges({ projectId, file, position }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForPosition(projectId, root, file, languageId, position);
      if (angular) {
        const viaAngular = await serverLinkedEditingRanges(
          db, projectId, root, file, languageId, position, ctx.signal, angular.target,
        );
        if (ctx.signal.aborted) return null;
        if (viaAngular) return viaAngular;
      }
      if (isTsFile(file)) return null;
      const primary = serverForLanguage(languageId);
      if (!primary || primary.id === angular?.def.id) return null;
      return serverLinkedEditingRanges(
        db, projectId, root, file, languageId, position, ctx.signal, primary.id,
      );
    },

    async diagnostics({ projectId, file, content }) {
      if (!file || !isTsFile(file)) return [];
      const root = requireProjectRoot(projectId);
      const diagnostics = await exec().tsDiagnostics(opCtx(projectId, root, file, undefined, content));
      return diagnostics.map<DiagnosticItem>((diagnostic) => ({
        file: diagnostic.file,
        range: {
          start: { line: diagnostic.line, column: diagnostic.column },
          end: { line: diagnostic.line, column: diagnostic.column },
        },
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: 'ts',
        code: diagnostic.code,
      }));
    },

    async semanticTokens({ projectId, file, content }, ctx) {
      const root = requireProjectRoot(projectId);
      if (isTsFile(file)) {
        const data = await exec().tsSemanticTokens(opCtx(projectId, root, file, undefined, content));
        return { data };
      }
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const viaServer = await serverSemanticTokens(db, projectId, root, file, languageId, ctx.signal);
      return viaServer ?? { data: [] };
    },

    async codeActions({ projectId, file, range, trigger }, ctx) {
      const root = requireProjectRoot(projectId);
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const angular = angularOverlayForRange(projectId, root, file, languageId, range);
      const angularPending = angular
        ? serverCodeActions(
          db, projectId, root, file, languageId, range, trigger ?? 'invoke', ctx.signal, angular.target,
        )
        : Promise.resolve(null);
      if (isTsFile(file)) {
        const [viaAngular, viaTs] = await Promise.all([
          angularPending,
          exec().tsCodeActions(opCtx(projectId, root, file, undefined, undefined, languageId, range)),
        ]);
        if (ctx.signal.aborted) return [];
        return mergeCodeActions(viaAngular ?? [], viaTs);
      }
      const primary = serverForLanguage(languageId);
      const primaryPending = primary && primary.id !== angular?.def.id
        ? serverCodeActions(
          db, projectId, root, file, languageId, range, trigger ?? 'invoke', ctx.signal, primary.id,
        )
        : Promise.resolve(null);
      const [viaAngular, viaPrimary] = await Promise.all([angularPending, primaryPending]);
      if (ctx.signal.aborted) return [];
      return mergeCodeActions(viaAngular ?? [], viaPrimary ?? []);
    },

    async resolveCodeAction({ projectId, action }, ctx) {
      requireProjectRoot(projectId);
      return serverResolveCodeAction(db, projectId, action, ctx.signal);
    },

    async executeCodeAction({ projectId, action }) {
      requireProjectRoot(projectId);
      return serverExecuteCodeAction(db, projectId, action);
    },
  };
}
