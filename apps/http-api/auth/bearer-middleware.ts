import type { HttpContext, MiddlewareHandler } from '@mcp/shared/http/router.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { EnforceRateLimit } from '@mcp/services/auth/use-cases/enforce-rate-limit.js';
import type { RecordAudit } from '@mcp/services/auth/use-cases/record-audit.js';
import type { ValidateBearerToken } from '@mcp/services/auth/use-cases/validate-bearer-token.js';
import { presentAuthError } from './error-presenter.js';
import { parseBearerHeader, safeRequestHeaders } from './headers.js';

interface BearerMiddlewareDeps {
  validate: ValidateBearerToken;
  enforceRate?: EnforceRateLimit;
  audit: RecordAudit;
  issuer?: string;
  newRequestId: () => string;
}

/**
 * Unified auth middleware. Runs validate → rate-limit. On success, stores
 * the AuthContext for downstream handlers.
 */
export function bearerMiddleware(deps: BearerMiddlewareDeps): MiddlewareHandler {
  return async (c: HttpContext, next) => {
    const rawBearer = parseBearerHeader(c.req.header('authorization'));
    const result = deps.validate.execute({
      rawBearer,
      requestId: deps.newRequestId(),
      requestHeaders: safeRequestHeaders(c.req.raw.headers),
    });

    if (!result.ok) {
      deps.audit.execute({
        principal: null,
        tokenType: null,
        event: 'auth_fail',
        status: 401,
        toolName: null,
        meta: { kind: result.error.kind },
      });
      return presentAuthError(c, result.error, deps.issuer);
    }

    const ctx: AuthContext = result.value;

    if (deps.enforceRate) {
      const gate = deps.enforceRate.execute(ctx.principal);
      if (!gate.ok) {
        deps.audit.execute({
          principal: ctx.principal,
          tokenType: ctx.tokenType,
          event: 'rate_limited',
          status: 429,
          toolName: null,
          meta: {},
        });
        return presentAuthError(c, gate.error, deps.issuer);
      }
    }

    deps.audit.execute({
      principal: ctx.principal,
      tokenType: ctx.tokenType,
      event: 'auth_ok',
      status: 200,
      toolName: null,
      meta: {},
    });

    c.set('authCtx', ctx);
    await next();
  };
}

/**
 * Typed accessor for the authenticated request context.
 */
export function getAuthCtx(c: HttpContext): AuthContext | undefined {
  return c.get<AuthContext>('authCtx');
}
