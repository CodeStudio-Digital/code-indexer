import type { Context } from 'hono';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type { CompanySessionId } from '@mcp/session-storage';
import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
} from '@mcp/company/types.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { resolveCompanySessionContext } from '../_helpers.js';

export type CompanyRouteSurface = 'kanban';

export interface CompanyRouteRuntime {
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
export async function resolveCompanyRouteRuntime(
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

export async function routeAllowsCompanySurface(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
  surface: CompanyRouteSurface,
): Promise<boolean> {
  const runtime = await resolveCompanyRouteRuntime(sessionStore, sessionId);
  if (!runtime) return false;
  return surface === 'kanban' && runtime.capabilities.allowCompanyKanban;
}

/** App-owned teams keep lifecycle reads/streaming in Company, but every
 * destructive/config mutation must enter through the App facade so workflow
 * attempts and compatibility state are updated atomically. */
export async function isAppOwnedCompanySession(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
): Promise<boolean> {
  return (await resolveCompanyRouteRuntime(sessionStore, sessionId))?.runtimeKind === 'app_studio';
}

export function appOwnedControlPlaneConflict(c: Context, operation: string) {
  return c.json({
    error: `App Studio owns this team's ${operation}. Use the App workflow/team controls instead.`,
    code: 'APP_STUDIO_CONTROL_PLANE_OWNED',
    runtime_kind: 'app_studio',
    operation,
  }, 409);
}

/** Stable 409 used by every incompatible Company mutation. */
export function companySurfaceConflict(c: Context, surface: CompanyRouteSurface) {
  return c.json({
    error: `Company ${surface} is unavailable for App Studio teams; use the App workflow instead.`,
    code: 'COMPANY_SURFACE_UNAVAILABLE_FOR_APP',
    runtime_kind: 'app_studio',
    surface,
  }, 409);
}
