import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const ROUTE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Stable identity selected by a framework-aware resolver. `workspaceRoot` is
 * runtime-only: it scopes the process and document replay but is never part of
 * the externally visible route id.
 */
export interface LspRouteIdentity {
  familyId: string;
  profileId: string;
  workspaceFingerprint: string;
  workspaceRoot?: string;
}

export interface LspRouteDescriptor extends LspRouteIdentity {
  routeId: string;
}

function routeSegment(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ROUTE_SEGMENT.test(normalized)) {
    throw new Error(`${label} must be a safe route identifier`);
  }
  return normalized;
}

/** Deterministic, path-free identity safe to persist in diagnostics/resolve payloads. */
export function defineLspRoute(identity: LspRouteIdentity): LspRouteDescriptor {
  const familyId = routeSegment(identity.familyId, 'familyId');
  const profileId = routeSegment(identity.profileId, 'profileId');
  const workspaceFingerprint = identity.workspaceFingerprint.trim();
  if (!workspaceFingerprint || workspaceFingerprint.length > 512) {
    throw new Error('workspaceFingerprint must be between 1 and 512 characters');
  }
  const digest = createHash('sha256')
    .update('mcp-lsp-route-v1\0')
    .update(familyId)
    .update('\0')
    .update(profileId)
    .update('\0')
    .update(workspaceFingerprint)
    .digest('hex')
    .slice(0, 24);
  return {
    ...identity,
    familyId,
    profileId,
    workspaceFingerprint,
    routeId: `lsp-route:${familyId}:${profileId}:${digest}`,
  };
}

function pathInside(parent: string, candidate: string): boolean {
  const delta = relative(parent, candidate);
  return delta === '' || (delta !== '..' && !delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(delta));
}

/** Resolve and constrain a route workspace to the owning project. */
export function workspaceRootForLspRoute(
  projectRoot: string,
  route: LspRouteDescriptor,
): string | null {
  const canonicalProjectRoot = resolve(projectRoot);
  const workspaceRoot = route.workspaceRoot
    ? resolve(canonicalProjectRoot, route.workspaceRoot)
    : canonicalProjectRoot;
  return pathInside(canonicalProjectRoot, workspaceRoot) ? workspaceRoot : null;
}

/** Project-relative document ownership used for replay and ready fan-out. */
export function lspRouteOwnsDocument(
  projectRoot: string,
  workspaceRoot: string,
  file: string,
): boolean {
  const canonicalProjectRoot = resolve(projectRoot);
  const document = resolve(canonicalProjectRoot, file);
  return pathInside(canonicalProjectRoot, document) && pathInside(resolve(workspaceRoot), document);
}

/** Whether metadata at `changedPath` can affect a route's workspace scope. */
export function lspRouteAffectedByPath(workspaceRoot: string, changedPath: string): boolean {
  const workspace = resolve(workspaceRoot);
  const metadataRoot = dirname(resolve(changedPath));
  return pathInside(workspace, metadataRoot) || pathInside(metadataRoot, workspace);
}
