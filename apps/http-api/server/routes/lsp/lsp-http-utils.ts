import type { Context } from 'hono';
import { ApiError } from '@mcp/api-bus';

export function mapLspApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status as never);
  }
  throw err;
}
