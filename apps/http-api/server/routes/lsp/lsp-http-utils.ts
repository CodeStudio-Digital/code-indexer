import type { HttpContext } from '@mcp/shared/http/router.js';
import { ApiError } from '@mcp/api-bus';

export function mapLspApiError(c: HttpContext, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}
