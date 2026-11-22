/** Host-owned bridge between Angular workspace detection and LSP route APIs. */
import type { LspServerRouteInfo } from '@mcp/api-bus';
import { createPool, resolveWorkerSpec } from '@mcp/indexer/workers/pool.js';
import { angularProjectFile, loadAngularWorkspaceIndex, peekAngularWorkspaceIndex, type AngularWorkspaceIndex } from '@mcp/services/lsp/angular-workspace-index.js';
import {
  angularRouteIdentity,
  resolveAngularServerRoute,
  type AngularServerRoute,
} from '@mcp/services/lsp/angular-server-route.js';
import { defineLspRoute, type LspRouteIdentity } from '@mcp/services/lsp/lsp-route.js';
import { allLspServers } from '@mcp/services/lsp/server-registry.js';
import type { LspServerDef } from '@mcp/services/lsp/lsp-server-types.js';
import type { LspServerTarget } from './server-backend.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { angularVersionOverrides } from './angular-profile-overrides.js';
import type { AngularIndexRequest } from './angular-workspace-worker.js';

const spec = resolveWorkerSpec(import.meta.url, './angular-workspace-worker');
const discovery = createPool<AngularIndexRequest, AngularWorkspaceIndex>({
  name: 'angular-workspace', size: 1, idleTtlMs: 60_000, workerUrl: spec.url, workerData: spec.bootstrapData,
});

export interface AngularProfileRouteContext {
  selection: AngularServerRoute;
  identity?: LspRouteIdentity;
}

export interface AngularProfileTarget extends AngularProfileRouteContext {
  def: LspServerDef;
  target: LspServerTarget;
}

function angularProfiles(languageId: string) {
  return allLspServers().filter((def) =>
    def.role === 'overlay'
    && def.projectResolver === 'angular-core'
    && def.languages.includes(languageId));
}

export function projectAngularDiscovery(db: CodeIndexDB) {
  return {
    cached(projectId: number, root: string) {
      return peekAngularWorkspaceIndex(root, { overrides: angularVersionOverrides(db, projectId) })?.nestedMarkers;
    },
    load(projectId: number, root: string) {
      const overrides = angularVersionOverrides(db, projectId);
      return loadAngularWorkspaceIndex(root, { overrides }, () => discovery.dispatch({ root, overrides }));
    },
  };
}

export async function resolveAngularProfileRoute(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  file: string,
  languageId: string,
): Promise<AngularProfileRouteContext> {
  const profiles = angularProfiles(languageId);
  if (!profiles.length || process.env.MCP_ANGULAR_LSP_ENABLED === '0') {
    return { selection: resolveAngularServerRoute(projectRoot, file, profiles) };
  }
  if (!angularProjectFile(projectRoot, file)) return { selection: { state: 'not-angular' } };
  const overrides = angularVersionOverrides(db, projectId);
  const index = await projectAngularDiscovery(db).load(projectId, projectRoot);
  const selection = resolveAngularServerRoute(projectRoot, file, profiles, { overrides }, index);
  return { selection, identity: angularRouteIdentity(selection) ?? undefined };
}

export async function angularProfileTarget(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  file: string,
  languageId: string,
): Promise<AngularProfileTarget | undefined> {
  const context = await resolveAngularProfileRoute(db, projectId, projectRoot, file, languageId);
  const def = context.selection.def;
  if (!def || !context.identity) return undefined;
  return {
    ...context,
    def,
    target: { serverId: def.id, identity: context.identity },
  };
}

export function angularRouteInfo(
  _projectRoot: string,
  context: AngularProfileRouteContext,
): LspServerRouteInfo | undefined {
  const { selection, identity } = context;
  const workspace = selection.workspace;
  if (!workspace) return undefined;
  return {
    routeId: identity ? defineLspRoute(identity).routeId : undefined,
    workspaceId: workspace.id,
    workspacePath: workspace.overridePath,
    familyId: selection.familyId,
    profileId: selection.profileId,
    projectVersion: workspace.version ?? undefined,
    projectMajor: workspace.major ?? undefined,
    versionSource: workspace.versionSource,
    confidence: workspace.confidence,
    supportTier: selection.supportTier,
  };
}
