/** Host-owned bridge between Angular workspace detection and LSP route APIs. */
import type { LspServerRouteInfo } from '@mcp/api-bus';
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

export function resolveAngularProfileRoute(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  file: string,
  languageId: string,
): AngularProfileRouteContext {
  const selection = resolveAngularServerRoute(projectRoot, file, angularProfiles(languageId), {
    overrides: angularVersionOverrides(db, projectId),
  });
  return { selection, identity: angularRouteIdentity(selection) ?? undefined };
}

export function angularProfileTarget(
  db: CodeIndexDB,
  projectId: number,
  projectRoot: string,
  file: string,
  languageId: string,
): AngularProfileTarget | undefined {
  const context = resolveAngularProfileRoute(db, projectId, projectRoot, file, languageId);
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
