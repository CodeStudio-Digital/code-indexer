import { readFileSync } from 'node:fs';
import { ApiError, type DiagnosticItem } from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import { serverForLanguage, syncPluginLanguageServers } from '@mcp/services/lsp/server-registry.js';
import type { HandlerDeps } from '../types.js';
import { startLintService } from '../lint/service.js';
import { getDoc } from './document-store.js';
import { publishDiagnostics } from './diagnostics-hub.js';
import { ensureLspManager } from './server-backend.js';
import { createInProcessLspExecutor } from './executor-inproc.js';
import { getLspExecutor } from './executor-holder.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';
import { syntaxDiagnosticsFor } from './syntax-diagnostics.js';
import {
  shouldUseAngularInteractiveOverlay,
  shouldUseAngularInteractiveOverlayRange,
} from './angular-overlay-routing.js';
import { angularProfileTarget, type AngularProfileTarget } from './angular-profile-routing.js';

const TS_DIAG_DEBOUNCE_MS = 500;
/** Module singletons survive the dual handler instances used by Electron. */
const tsDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syntaxDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface LspHandlerContext {
  db: HandlerDeps['db'];
  lspManager: ReturnType<typeof ensureLspManager>;
  exec(): LspBackendExecutor;
  requireProjectRoot(projectId: number): string;
  angularOverlayForPosition(
    projectId: number,
    root: string,
    file: string,
    languageId: string,
    position: { line: number; column: number },
    providedContent?: string,
  ): Promise<AngularProfileTarget | undefined>;
  angularOverlayForRange(
    projectId: number,
    root: string,
    file: string,
    languageId: string,
    range: { start: { line: number; column: number }; end: { line: number; column: number } },
  ): Promise<AngularProfileTarget | undefined>;
  opCtx(
    projectId: number,
    root: string,
    file: string,
    position?: { line: number; column: number },
    content?: string,
    languageId?: string,
    range?: { start: { line: number; column: number }; end: { line: number; column: number } },
  ): LspOpCtx;
  scheduleTsDiagnostics(projectId: number, root: string, file: string): void;
  scheduleSyntaxDiagnostics(projectId: number, root: string, file: string, languageId: string): void;
  clearDiagnosticTimers(projectId: number, file: string): void;
}

export function createLspHandlerContext(deps: HandlerDeps): LspHandlerContext {
  const { db } = deps;
  const syncedServers = syncPluginLanguageServers();
  const lspManager = ensureLspManager(db);
  const staleServerIds = [...new Set([...syncedServers.removed, ...syncedServers.changed])];
  if (staleServerIds.length > 0) {
    void Promise.allSettled(staleServerIds.map((serverId) => lspManager.stopServer(serverId)));
  }

  startLintService(db);
  const inproc = createInProcessLspExecutor(db);
  const exec = (): LspBackendExecutor => getLspExecutor() ?? inproc;

  const requireProjectRoot = (projectId: number): string => {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  };

  const contentForRouting = (
    projectId: number,
    root: string,
    file: string,
    provided?: string,
  ): string | null => {
    if (provided !== undefined) return provided;
    const live = getDoc(projectId, file);
    if (live) return live.content;
    try { return readFileSync(relToAbsCanonical(root, file), 'utf-8'); } catch { return null; }
  };

  const angularOverlayForPosition: LspHandlerContext['angularOverlayForPosition'] = async (
    projectId, root, file, languageId, position, providedContent,
  ) => {
    const overlay = await angularProfileTarget(db, projectId, root, file, languageId);
    if (!overlay) return undefined;
    return shouldUseAngularInteractiveOverlay({
      projectId,
      file,
      languageId,
      content: contentForRouting(projectId, root, file, providedContent),
      position,
    }) ? overlay : undefined;
  };

  const angularOverlayForRange: LspHandlerContext['angularOverlayForRange'] = async (
    projectId, root, file, languageId, range,
  ) => {
    const overlay = await angularProfileTarget(db, projectId, root, file, languageId);
    if (!overlay) return undefined;
    return shouldUseAngularInteractiveOverlayRange({
      projectId,
      file,
      languageId,
      content: contentForRouting(projectId, root, file),
      range,
    }) ? overlay : undefined;
  };

  const opCtx: LspHandlerContext['opCtx'] = (
    projectId, root, file, position, content, languageId, range,
  ) => ({
    projectId,
    root,
    file,
    position,
    range,
    content,
    languageId,
    docVersion: getDoc(projectId, file)?.version,
  });

  const scheduleTsDiagnostics = (projectId: number, root: string, file: string): void => {
    if (!isTsFile(file)) return;
    const key = `${projectId}:${file}`;
    const previous = tsDiagTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      tsDiagTimers.delete(key);
      exec().tsDiagnostics(opCtx(projectId, root, file))
        .then((diagnostics) => publishDiagnostics(projectId, {
          file,
          source: 'ts',
          diagnostics: diagnostics.map<DiagnosticItem>((diagnostic) => ({
            file,
            range: {
              start: { line: diagnostic.line, column: diagnostic.column },
              end: { line: diagnostic.line, column: diagnostic.column },
            },
            severity: diagnostic.severity,
            message: diagnostic.message,
            source: 'ts',
            code: diagnostic.code,
          })),
        }))
        .catch(() => undefined);
    }, TS_DIAG_DEBOUNCE_MS);
    timer.unref?.();
    tsDiagTimers.set(key, timer);
  };

  const scheduleSyntaxDiagnostics = (
    projectId: number,
    root: string,
    file: string,
    languageId: string,
  ): void => {
    if (isTsFile(file) || languageId === 'plaintext') return;
    const key = `${projectId}:${file}`;
    const previous = syntaxDiagTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      void run().catch(() => undefined);
    }, TS_DIAG_DEBOUNCE_MS);
    async function run(): Promise<void> {
      const angular = await angularProfileTarget(db, projectId, root, file, languageId).catch(() => undefined);
      if (syntaxDiagTimers.get(key) !== timer) return;
      syntaxDiagTimers.delete(key);
      const primary = serverForLanguage(languageId);
      const status = angular
        ? lspManager.statusById(projectId, angular.def.id, languageId, angular.identity)
        : primary
          ? lspManager.statusById(projectId, primary.id, languageId)
          : { state: 'no-server' as const };
      if (status.state === 'ready') {
        publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] });
        return;
      }
      const content = getDoc(projectId, file)?.content;
      if (content === undefined) return;
      syntaxDiagnosticsFor(file, content)
        .then((diagnostics) => publishDiagnostics(projectId, {
          file,
          source: 'syntax',
          diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic, file })),
        }))
        .catch(() => publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] }));
    }
    timer.unref?.();
    syntaxDiagTimers.set(key, timer);
  };

  const clearDiagnosticTimers = (projectId: number, file: string): void => {
    const key = `${projectId}:${file}`;
    const tsTimer = tsDiagTimers.get(key);
    if (tsTimer) { clearTimeout(tsTimer); tsDiagTimers.delete(key); }
    const syntaxTimer = syntaxDiagTimers.get(key);
    if (syntaxTimer) { clearTimeout(syntaxTimer); syntaxDiagTimers.delete(key); }
  };

  return {
    db,
    lspManager,
    exec,
    requireProjectRoot,
    angularOverlayForPosition,
    angularOverlayForRange,
    opCtx,
    scheduleTsDiagnostics,
    scheduleSyntaxDiagnostics,
    clearDiagnosticTimers,
  };
}
