import { Hono } from 'hono';
import type { AuthBundle } from '../auth/composition.js';
import { presentAuthError } from '../auth/error-presenter.js';

/**
 * /oauth/authorize — PKCE-only authorization endpoint.
 *
 * Single-user localhost model: no user login. The GET form renders a minimal
 * consent page; the POST form creates the authorization code and redirects.
 * Production deployments behind multi-user scenarios should add login
 * middleware BEFORE this router.
 */
export function createAuthorizeRouter(bundle: AuthBundle): Hono {
  const app = new Hono();

  app.get('/authorize', (c) => {
    const q = c.req.query();
    const params = extractParams(q);
    if ('error' in params) return c.json(params.error, 400);

    const html = renderConsent(params);
    return c.html(html);
  });

  app.post('/authorize', async (c) => {
    const form = await c.req.parseBody();
    const params = extractParams(form as Record<string, string>);
    if ('error' in params) return c.json(params.error, 400);

    const decision = (form.decision as string | undefined) ?? 'deny';
    if (decision !== 'approve') {
      const url = new URL(params.redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (params.state) url.searchParams.set('state', params.state);
      return c.redirect(url.toString(), 302);
    }

    const result = bundle.startAuthorization.execute({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      scopes: params.scopes,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
    });

    if (!result.ok) return presentAuthError(c, result.error);

    const url = new URL(params.redirectUri);
    url.searchParams.set('code', result.value.code);
    if (params.state) url.searchParams.set('state', params.state);
    return c.redirect(url.toString(), 302);
  });

  return app;
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  codeChallenge: string;
  state: string | null;
}

function extractParams(raw: Record<string, string>):
  | AuthorizeParams
  | { error: { error: string; error_description: string } } {
  const responseType = raw.response_type;
  if (responseType !== 'code') {
    return { error: { error: 'unsupported_response_type', error_description: 'response_type must be "code"' } };
  }
  const clientId = raw.client_id ?? '';
  const redirectUri = raw.redirect_uri ?? '';
  const codeChallenge = raw.code_challenge ?? '';
  const codeChallengeMethod = raw.code_challenge_method ?? '';
  if (!clientId || !redirectUri) {
    return { error: { error: 'invalid_request', error_description: 'client_id and redirect_uri required' } };
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return { error: { error: 'invalid_request', error_description: 'PKCE S256 required' } };
  }
  const scopes = raw.scope ? raw.scope.split(' ').filter(Boolean) : ['mcp:read', 'mcp:write'];
  return {
    clientId,
    redirectUri,
    scopes,
    codeChallenge,
    state: raw.state ?? null,
  };
}

function renderConsent(p: AuthorizeParams): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorize</title>
<style>body{font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem}
button{padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}</style></head>
<body>
<h1>Authorize application</h1>
<p>Client <code>${esc(p.clientId)}</code> is requesting access with scopes:</p>
<ul>${p.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('')}</ul>
<form method="post" action="/oauth/authorize">
  ${hidden('response_type', 'code')}
  ${hidden('client_id', p.clientId)}
  ${hidden('redirect_uri', p.redirectUri)}
  ${hidden('scope', p.scopes.join(' '))}
  ${hidden('code_challenge', p.codeChallenge)}
  ${hidden('code_challenge_method', 'S256')}
  ${p.state ? hidden('state', p.state) : ''}
  <button type="submit" name="decision" value="approve">Approve</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`;
}
