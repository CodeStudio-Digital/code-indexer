import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  CompanySessionFiles,
  type CompanySessionFileSnapshot,
} from '@mcp/company/services/CompanySessionFiles.js';

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

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse an opaque filesystem-session UUID.
 *
 * This is intentionally separate from `parseIdParam`: project ids and the few
 * remaining essential SQLite ids stay numeric, while public session ids never
 * pass through integer coercion or a legacy fallback.
 */
export function parseSessionIdParam(c: Context, key = 'id'): SessionId {
  return parseSessionIdValue(c.req.param(key) ?? '', key);
}

/** Parse an opaque UUID for a record stored inside a session bundle. */
export function parseSessionRecordIdParam(c: Context, key: string): string {
  const raw = c.req.param(key) ?? '';
  if (!CANONICAL_UUID.test(raw)) {
    throw new HTTPException(400, {
      message: `${key} must be a canonical UUID`,
    });
  }
  return raw.toLowerCase();
}

/** Parse a Company/App Studio filesystem-session UUID. */
export function parseCompanySessionIdParam(
  c: Context,
  key = 'id',
): CompanySessionId {
  const raw = c.req.param(key) ?? '';
  if (!CANONICAL_UUID.test(raw)) {
    throw new HTTPException(400, {
      message: `${key} must be a canonical company session UUID`,
    });
  }
  return asCompanySessionId(raw.toLowerCase());
}

/** Validate a session UUID received outside the URL path, e.g. a JSON batch. */
export function parseSessionIdValue(value: unknown, label = 'session_id'): SessionId {
  const raw = typeof value === 'string' ? value : '';
  if (!CANONICAL_UUID.test(raw)) {
    throw new HTTPException(400, { message: `${label} must be a canonical session UUID` });
  }
  return asSessionId(raw.toLowerCase());
}

/** Parse a positive numeric sequence path parameter (conversation order). */
export function parseSeqParam(c: Context, key = 'seq'): number {
  return parseSeqValue(c.req.param(key) ?? '', key);
}

/** Validate a positive sequence received outside a URL path, e.g. JSON input. */
export function parseSeqValue(value: unknown, label = 'seq'): number {
  const raw = typeof value === 'number'
    ? (Number.isSafeInteger(value) ? String(value) : '')
    : typeof value === 'string'
      ? value
      : '';
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new HTTPException(400, { message: `${label} must be a positive sequence number` });
  }
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq)) {
    throw new HTTPException(400, { message: `${label} exceeds the safe sequence range` });
  }
  return seq;
}

/**
 * Parse a non-negative sequence cursor. Absence uses the supplied default;
 * malformed values fail closed instead of being silently coerced.
 */
export function parseSeqQuery(c: Context, key: string, defaultValue = 0): number {
  const raw = c.req.query(key);
  if (raw == null || raw === '') return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new HTTPException(400, { message: `${key} must be a non-negative sequence number` });
  }
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq)) {
    throw new HTTPException(400, { message: `${key} exceeds the safe sequence range` });
  }
  return seq;
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
 * Resolve a Company/App Studio bundle and its root exclusively through the
 * filesystem catalog + session.json. Missing parents fail closed; there is no
 * SQLite or legacy-id fallback.
 */
interface ResolvedCompanySessionContext {
  requestedId: CompanySessionId;
  rootId: CompanySessionId;
  requestedFiles: CompanySessionFiles;
  rootFiles: CompanySessionFiles;
  requested: CompanySessionFileSnapshot;
  root: CompanySessionFileSnapshot;
}

export async function resolveCompanySessionContext(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
): Promise<ResolvedCompanySessionContext | null> {
  await sessionStore.ensureCatalog();
  try {
    const requestedFiles = new CompanySessionFiles({
      companySessionId: sessionId,
      sessionStore,
    });
    const requested = requestedFiles.getSession();
    const rootId = requested.parent_session_id ?? sessionId;
    const rootFiles =
      rootId === sessionId
        ? requestedFiles
        : new CompanySessionFiles({
            companySessionId: rootId,
            sessionStore,
          });
    return {
      requestedId: sessionId,
      rootId,
      requestedFiles,
      rootFiles,
      requested,
      root: rootFiles.getSession(),
    };
  } catch {
    return null;
  }
}

export async function resolveRootSessionId(
  sessionStore: FsSessionStore,
  sessionId: CompanySessionId,
): Promise<CompanySessionId | null> {
  return (await resolveCompanySessionContext(sessionStore, sessionId))?.rootId ?? null;
}
