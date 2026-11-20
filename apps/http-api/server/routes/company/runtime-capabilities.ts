import type { HttpContext } from '@mcp/shared/http/router.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { CompanySessionId } from '@mcp/session-storage';
import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
} from '@mcp/company/types.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { resolveCompanySessionContext } from '../_helpers.js';

type CompanyRouteSurface = 'kanban';

interface CompanyRouteRuntime {
  requestedSessionId: CompanySessionId;
  rootSessionId: CompanySessionId;
  runtimeKind: CompanyRuntimeKind;
  capabilities: CompanySessionCapabilities;
}

/**
 * Resolve a route's capability from the persisted, server-owned runtime kind.
 * The App link is deliberately not needed for generic Company surfaces:
 * `app_studio` denies Company Kanban whether the link is healthy or broken.
 */
async function resolveCompanyRouteRuntime(
  sessionStore: FsSessionStore,
  requestedSessionId: CompanySessionId,
): Promise<CompanyRouteRuntime | null> {
  const context = await resolveCompanySessionContext(
    sessionStore,
    requestedSessionId,
  );
  if (!context) return null;
  const runtimeKind: CompanyRuntimeKind = context.root.runtime_kind === 'app_studio'
    ? 'app_studio'
    : 'company';
  return {
    requestedSessionId,
    rootSessionId: context.rootId,
    runtimeKind,
    capabilities: resolveCompanySessionCapabilities(runtimeKind, null),
  };
}

async function routeAllowsCompanySurface(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
  surface: CompanyRouteSurface,
): Promise<boolean> {
  const runtime = await resolveCompanyRouteRuntime(sessionStore, sessionId);
  if (!runtime) return false;
  return surface === 'kanban' && runtime.capabilities.allowCompanyKanban;
}

/** Retired App teams remain readable; mutations must preserve their archive. */
export async function isAppOwnedCompanySession(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
): Promise<boolean> {
  return (await resolveCompanyRouteRuntime(sessionStore, sessionId))?.runtimeKind === 'app_studio';
}

export function appOwnedControlPlaneConflict(c: HttpContext, operation: string) {
  return c.json({
    error: `App Studio has been retired. This team's ${operation} is unavailable; saved projects and history are preserved.`,
    code: 'APP_STUDIO_CONTROL_PLANE_OWNED',
    runtime_kind: 'app_studio',
    operation,
  }, 409);
}

/** Stable 409 used by every incompatible Company mutation. */
export function companySurfaceConflict(c: HttpContext, surface: CompanyRouteSurface) {
  return c.json({
    error: `Company ${surface} is unavailable for archived App Studio teams.`,
    code: 'COMPANY_SURFACE_UNAVAILABLE_FOR_APP',
    runtime_kind: 'app_studio',
    surface,
  }, 409);
}
