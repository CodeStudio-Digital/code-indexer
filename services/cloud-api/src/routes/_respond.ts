/** Single source of truth for domain-error → HTTP. Maps via the exhaustive
 *  identityHttpStatus and preserves error.details (retryAfterMs, reasons, …). */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { toErrorBody } from '@cloudstudio/cloud-kernel';
import { identityHttpStatus, type IdentityError } from '@cloudstudio/cloud-identity';
import type { Env } from '../env.js';

export function respondError(c: Context<{ Bindings: Env }>, error: IdentityError) {
  return c.json(toErrorBody(error), identityHttpStatus(error) as ContentfulStatusCode);
}
