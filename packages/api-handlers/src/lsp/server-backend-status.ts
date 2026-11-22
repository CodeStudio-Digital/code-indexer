import type { LspServerStatus } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import {
  angularRouteInfo,
  resolveAngularProfileRoute,
} from './angular-profile-routing.js';
import { shouldWarmLspStatus } from './lsp-status-policy.js';
import { ensureLspManager } from './server-backend-manager.js';
import { serverInfo } from './server-backend-mappers.js';

/** Language status for the editor CTA and status-bar chip. */
export async function serverStatusFor(
  db: CodeIndexDB,
  projectId: number,
  languageId: string,
  file?: string,
): Promise<LspServerStatus> {
  const manager = ensureLspManager(db);
  const root = db.getProject(projectId)?.root_path;
  const angular = root && file
    ? await resolveAngularProfileRoute(db, projectId, root, file, languageId)
    : undefined;
  if (angular && angular.selection.state !== 'selected' && angular.selection.state !== 'not-angular') {
    const state = angular.selection.state === 'needs-profile'
      ? 'needs-profile'
      : angular.selection.state === 'unsupported'
        ? 'unsupported'
        : 'disabled';
    return {
      state,
      reason: angular.selection.reason,
      route: root ? angularRouteInfo(root, angular) : undefined,
      autoPrompt: process.env.MCP_LSP_AUTO_PROMPT !== '0',
    };
  }
  const selected = angular?.selection.state === 'selected'
    ? angular.selection.def
    : file
      ? serverForLanguage(languageId)
      : undefined;
  const status = selected
    ? manager.statusById(projectId, selected.id, languageId, angular?.identity)
    : file
      ? { state: 'no-server' as const }
      : await manager.resolveStatus(projectId, languageId);
  if (shouldWarmLspStatus(file, status) && status.server) {
    void manager.acquireById(
      projectId,
      status.server.id,
      'status',
      angular?.identity,
    ).catch(() => undefined);
  }
  return {
    state: status.state,
    server: status.server ? serverInfo(status.server) : undefined,
    route: root && angular ? angularRouteInfo(root, angular) : undefined,
    reason: status.reason,
    runtime: status.runtime
      ? {
          kind: status.runtime.kind,
          minMajor: status.runtime.minMajor,
          satisfied: status.runtime.satisfied,
          version: status.runtime.version,
          reason: status.runtime.reason,
        }
      : undefined,
    nodeRuntime: status.nodeRuntime,
    autoPrompt: process.env.MCP_LSP_AUTO_PROMPT !== '0',
    workspaceMode: status.workspaceMode,
    workspaceReason: status.workspaceReason,
  };
}
