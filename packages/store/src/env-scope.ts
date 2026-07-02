/**
 * Pure helpers for `company_session_envs.service_scope` (migration 192).
 *
 * A scope is a free-form CSV of service ids ('api' or 'main,api').
 * Semantics:
 *   - NULL / empty / whitespace-only → the var applies to EVERY service.
 *   - Otherwise → only services whose id appears in the CSV.
 *
 * Matching is case-insensitive: service ids double as docker hostnames
 * (lowercase by construction), but tools/operators may type 'MAIN'.
 * Ids are NOT validated against live services on purpose — a dangling
 * id is harmless (the var reaches no container) and services churn far
 * more often than envs are edited.
 *
 * Kept dependency-free so the dashboard-independent callers (store,
 * env-sync, agent tools) and plain-node vitest can all share it.
 */

/** CSV → normalized id list. Empty result means "all services". */
export function parseServiceScope(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when a var with this scope must be materialized for `serviceId`. */
export function scopeIncludesService(
  scope: string | null | undefined,
  serviceId: string,
): boolean {
  const ids = parseServiceScope(scope);
  if (ids.length === 0) return true;
  return ids.includes(serviceId.trim().toLowerCase());
}

/**
 * Canonicalize a user/tool-provided scope for storage: trims each id,
 * drops empties, collapses "nothing left" to NULL (= all services).
 */
export function normalizeServiceScope(scope: string | null | undefined): string | null {
  const ids = parseServiceScope(scope);
  return ids.length > 0 ? ids.join(',') : null;
}
