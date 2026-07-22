import { ApiError } from '@mcp/api-bus';
import { absToRelCanonical, relToAbsCanonical } from '@mcp/shared/utils/fs-canonical.js';
import { defineLspRoute, type LspRouteIdentity } from '@mcp/services/lsp/lsp-route.js';
import type { LspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import type { LspServerDef } from '@mcp/services/lsp/lsp-server-types.js';
import type { AngularProfileTarget } from './angular-profile-routing.js';

type BoundRoute = NonNullable<ReturnType<LspServerManager['routeTarget']>>;

export type ValidatedRestartTarget =
  | { kind: 'route'; routeId: string }
  | { kind: 'server'; identity?: LspRouteIdentity };

interface RestartValidationInput {
  projectRoot: string;
  serverId: string;
  routeId?: unknown;
  file?: unknown;
  languageId?: string;
  def?: LspServerDef;
  boundRoute?: BoundRoute | null;
  angular?: AngularProfileTarget;
}

function conflict(message: string): never {
  throw new ApiError('conflict', 409, message);
}

function angularProfile(def: LspServerDef): boolean {
  return def.projectResolver === 'angular-core';
}

/** Reject stale or cross-profile restart targets before any process mutation. */
export function validateRestartServerTarget(input: RestartValidationInput): ValidatedRestartTarget {
  const { serverId, def, angular, languageId } = input;
  if (!def) throw new ApiError('not_found', 404, 'language server not found');
  if (input.routeId !== undefined
    && (typeof input.routeId !== 'string' || !input.routeId.trim())) {
    throw new ApiError('bad_input', 400, 'routeId must be a non-empty string');
  }
  if (input.file !== undefined && (typeof input.file !== 'string' || !input.file.trim())) {
    throw new ApiError('bad_input', 400, 'file must be a non-empty string');
  }
  const absoluteFile = typeof input.file === 'string'
    ? relToAbsCanonical(input.projectRoot, input.file)
    : undefined;
  if (absoluteFile && absToRelCanonical(input.projectRoot, absoluteFile) === null) {
    throw new ApiError('bad_input', 400, 'file must stay inside the project root');
  }

  const routeId = input.routeId as string | undefined;
  if (routeId) {
    const bound = input.boundRoute;
    if (!bound) throw new ApiError('not_found', 404, 'LSP route is stale or unknown');
    if (bound.serverId !== serverId) conflict('LSP route does not belong to requested server');
    if ((def.familyId && bound.familyId !== def.familyId)
      || (def.profileId && bound.profileId !== def.profileId)) {
      conflict('LSP route profile is stale or inconsistent');
    }
    if (absoluteFile && absToRelCanonical(bound.workspaceRoot, absoluteFile) === null) {
      conflict('file does not belong to the requested LSP route');
    }
    if (angularProfile(def) && input.file !== undefined) {
      if (!angular?.identity) conflict('LSP route no longer resolves to an Angular profile');
      const expectedRouteId = defineLspRoute(angular.identity).routeId;
      if (angular.def.id !== serverId
        || angular.def.familyId !== bound.familyId
        || angular.def.profileId !== bound.profileId
        || expectedRouteId !== routeId) {
        conflict('LSP route does not match the file or current Angular profile');
      }
    } else if (input.file !== undefined && languageId && !def.languages.includes(languageId)) {
      conflict('requested server does not support the file language');
    }
    return { kind: 'route', routeId };
  }

  if (angular) {
    if (!angular.identity || angular.def.id !== serverId) {
      conflict('requested server does not match the file Angular profile');
    }
    return { kind: 'server', identity: angular.identity };
  }
  if (angularProfile(def)) {
    if (input.file !== undefined) conflict('file no longer resolves to requested Angular profile');
    throw new ApiError('bad_input', 400, 'Angular profile restart requires routeId or file');
  }
  if (input.file !== undefined && languageId && !def.languages.includes(languageId)) {
    conflict('requested server does not support the file language');
  }
  return { kind: 'server' };
}
