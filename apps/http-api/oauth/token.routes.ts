import { HttpRouter } from '@mcp/shared/http/router.js';
import type { AuthBundle } from '../auth/composition.js';
import { presentAuthError } from '../auth/error-presenter.js';

/**
 * /oauth/token — authorization_code + refresh_token grants.
 * Accepts form-encoded body per RFC 6749.
 */
export function createTokenRouter(bundle: AuthBundle): HttpRouter {
  const app = new HttpRouter();

  app.post('/token', async (c) => {
    const body = await c.req.parseBody();
    const grantType = stringField(body, 'grant_type');
    const clientId = parseClientId(c, body);
    if (!clientId) {
      return c.json({ error: 'invalid_client' }, 400);
    }

    if (grantType === 'authorization_code') {
      const result = bundle.exchangeCode.execute({
        clientId,
        code: stringField(body, 'code'),
        redirectUri: stringField(body, 'redirect_uri'),
        codeVerifier: stringField(body, 'code_verifier'),
        clientSecret: stringField(body, 'client_secret') || undefined,
      });
      if (!result.ok) return presentAuthError(c, result.error);

      bundle.audit.execute({
        principal: clientId,
        tokenType: 'oauth',
        event: 'code_exchanged',
        status: 200,
        toolName: null,
        meta: { scope: result.value.scope },
      });

      return c.json({
        access_token: result.value.accessToken,
        token_type: 'Bearer',
        expires_in: result.value.expiresInSec,
        refresh_token: result.value.refreshToken,
        scope: result.value.scope,
      });
    }

    if (grantType === 'refresh_token') {
      const result = bundle.refreshAccess.execute({
        refreshToken: stringField(body, 'refresh_token'),
        clientId,
      });
      if (!result.ok) return presentAuthError(c, result.error);

      bundle.audit.execute({
        principal: clientId,
        tokenType: 'oauth',
        event: 'refresh_rotated',
        status: 200,
        toolName: null,
        meta: { scope: result.value.scope },
      });

      return c.json({
        access_token: result.value.accessToken,
        token_type: 'Bearer',
        expires_in: result.value.expiresInSec,
        refresh_token: result.value.refreshToken,
        scope: result.value.scope,
      });
    }

    return c.json(
      { error: 'unsupported_grant_type', error_description: `grant_type '${grantType}' not supported` },
      400,
    );
  });

  return app;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Resolves client_id from (a) Basic auth header, or (b) form field.
 * Basic auth format: Base64("clientId:clientSecret").
 */
function parseClientId(c: import('@mcp/shared/http/router.js').HttpContext, body: Record<string, unknown>): string | null {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) return decoded.slice(0, idx);
    } catch {
      return null;
    }
  }
  return stringField(body, 'client_id') || null;
}
