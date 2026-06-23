import type { Context } from 'hono';
import type { CompanyStore } from '@mcp/store/company-store.js';

/**
 * Small helpers shared across route modules to cut the boilerplate that
 * previously appeared dozens of times: `parseInt(c.req.param('id'), 10)`,
 * query-param parsing, JSON body parsing with a default, and 404 responses.
 *
 * Keep these free-function (no classes) so route handlers stay terse.
 */

/** Parse a URL param as an integer. Defaults to the `id` param. */
export function parseIdParam(c: Context, key = 'id'): number {
  return parseInt(c.req.param(key) ?? '', 10);
}

/** Parse a query param as integer with a default value. */
export function parseIntQuery(c: Context, key: string, defaultValue: number): number {
  const raw = c.req.query(key);
  if (raw == null) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Parse a JSON body, falling back to an empty object if parsing fails.
 * Eliminates the `await c.req.json<T>().catch(() => ({} as T))` pattern
 * repeated across many handlers.
 */
export async function parseJsonBody<T extends object>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

/**
 * Standardized 404 response. Replaces the scattered
 * `return c.json({ error: 'Not found' }, 404)` pattern.
 */
export function notFound(c: Context, message = 'Not found') {
  return c.json({ error: message }, 404);
}

/**
 * Resolve a `:id` URL param to its ROOT company session id (sub-sessions
 * → parent). Used by routes that mutate project-wide tables (kanban,
 * pipelines, env, services, databases, docs, design-system) so a
 * caller hitting them with a child id still operates on the parent's
 * shared state. Returns the input id when the row is missing or already
 * a root.
 */
export function resolveRootSessionId(companyStore: CompanyStore, sessionId: number): number {
  const session = companyStore.getCompanySession(sessionId);
  return session?.parent_session_id ?? sessionId;
}
