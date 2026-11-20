import type { HttpContext } from '@mcp/shared/http/router.js';
import { ApiError } from '@mcp/api-bus';

/**
 * HTTP routes for /api/projects/* — thin adapters that parse the request,
 * invoke the corresponding handler in `@mcp/api-handlers/projects`, and
 * serialize the result. The handlers are also mounted on Electron IPC
 * (see apps/electron/src/ipc/) so the business logic stays in one place.
 *
 * SSE adaptation: filesystem, git-status, and scaffold producers return
 * async iterables; this file wraps them into HttpRouter's streamSSE frames.
 * Electron instead pumps them onto a MessagePort.
 */
export function mapApiError(c: HttpContext, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status as never);
  }
  throw err;
}
