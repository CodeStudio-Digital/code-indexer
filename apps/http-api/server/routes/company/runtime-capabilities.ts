import type { Context } from 'hono';
import type { CompanyStore } from '@mcp/store/company-store.js';
import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
} from '@mcp/company/types.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import { resolveRootSessionId } from '../_helpers.js';

export type CompanyRouteSurface = 'kanban' | 'pipelines';

export interface CompanyRouteRuntime {
  requestedSessionId: number;
  rootSessionId: number;
  runtimeKind: CompanyRuntimeKind;
  capabilities: CompanySessionCapabilities;
}

/**
 * Resolve a route's capability from the persisted, server-owned runtime kind.
 * The App link is deliberately not needed for generic Company surfaces:
 * `app_studio` denies Kanban/pipelines whether the link is healthy or broken.
 */
export function resolveCompanyRouteRuntime(
  companyStore: CompanyStore,
  requestedSessionId: number,
): CompanyRouteRuntime | null {
  const rootSessionId = resolveRootSessionId(companyStore, requestedSessionId);
  const session = companyStore.getCompanySession(rootSessionId);
  if (!session) return null;
  // Compatibility with route fakes and pre-migration rows: only the explicit
  // persisted App value narrows capability; everything else remains Company.
  const runtimeKind: CompanyRuntimeKind = session.runtime_kind === 'app_studio'
    ? 'app_studio'
    : 'company';
  return {
    requestedSessionId,
    rootSessionId,
    runtimeKind,
    capabilities: resolveCompanySessionCapabilities(runtimeKind, null),
  };
}

export function routeAllowsCompanySurface(
  companyStore: CompanyStore,
  sessionId: number,
  surface: CompanyRouteSurface,
): boolean {
  const runtime = resolveCompanyRouteRuntime(companyStore, sessionId);
  if (!runtime) return false;
  return surface === 'kanban'
    ? runtime.capabilities.allowCompanyKanban
    : runtime.capabilities.allowCompanyPipelines;
}

/** App-owned teams keep lifecycle reads/streaming in Company, but every
 * destructive/config mutation must enter through the App facade so workflow
 * attempts and compatibility state are updated atomically. */
export function isAppOwnedCompanySession(
  companyStore: CompanyStore,
  sessionId: number,
): boolean {
  return resolveCompanyRouteRuntime(companyStore, sessionId)?.runtimeKind === 'app_studio';
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
