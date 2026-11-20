import { HttpRouter } from '@mcp/shared/http/router.js';
import type { AuthBundle } from '../auth/composition.js';
import type { McpTier } from '@mcp/services/auth/domain/api-token.js';

interface CreateTokenBody {
  name?: unknown;
  scopes?: unknown;
  expiresInDays?: unknown;
  tier?: unknown;
  profileId?: unknown;
}

/**
 * When the operator picks a tier in the admin UI, derive a default
 * scope set so legacy scope-based code paths (resource reads, audit
 * meta, etc.) still see a meaningful value. The tier itself is the
 * authoritative check at tool-list/tool-call time.
 *
 *   bootstrap → mcp:read         (read-only catalogue)
 *   navigate  → mcp:read + write (edit/run tools active)
 *   admin     → adds mcp:admin   (git mutations, project admin)
 */
function defaultScopesForTier(tier: McpTier): string[] {
  switch (tier) {
    case 'bootstrap':
      return ['mcp:read'];
    case 'navigate':
      return ['mcp:read', 'mcp:write'];
    case 'admin':
      return ['mcp:read', 'mcp:write', 'mcp:admin'];
  }
}

function parseTier(raw: unknown): McpTier | null {
  if (raw === 'bootstrap' || raw === 'navigate' || raw === 'admin') return raw;
  return null;
}

/**
 * Admin routes for API token lifecycle.
 *   POST   /api-tokens         — create (returns raw token ONCE)
 *   GET    /api-tokens         — list (raw tokens never returned)
 *   DELETE /api-tokens/:id     — revoke
 *
 * Mounted under /api/admin by the root router. These routes are currently
 * unauthenticated (project convention: admin UI is localhost). When that
 * changes, add a middleware on this sub-router.
 */
export function createApiTokensRouter(bundle: AuthBundle): HttpRouter {
  const app = new HttpRouter();

  app.post('/api-tokens', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateTokenBody;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return c.json({ error: 'name is required' }, 400);

    const tier = parseTier(body.tier);
    const profileId = typeof body.profileId === 'string' && body.profileId.trim()
      ? body.profileId.trim()
      : null;

    // When a tier is selected, the admin UI doesn't bother surfacing
    // scope toggles — the tier is the authoritative gate. We still
    // persist a sensible scope set so existing scope-based audit/policy
    // hooks keep working without special-casing tier-bound tokens.
    const scopes = tier
      ? defaultScopesForTier(tier)
      : Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === 'string')
        ? (body.scopes as string[])
        : ['mcp:read', 'mcp:write'];

    const expiresInDays = typeof body.expiresInDays === 'number' && body.expiresInDays > 0
      ? body.expiresInDays
      : undefined;

    let out;
    try {
      out = bundle.issueApiToken.execute({ name, scopes, expiresInDays, tier, profileId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
    bundle.audit.execute({
      principal: out.id,
      tokenType: 'api_token',
      event: 'token_issued',
      status: 201,
      toolName: null,
      meta: { name, scopes, tier, profileId, expiresInDays: expiresInDays ?? null },
    });
    return c.json({ id: out.id, rawToken: out.rawToken, tier, profileId }, 201);
  });

  app.get('/api-tokens', (c) => {
    const tokens = bundle.listApiTokens.execute().map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes.values(),
      expires_at: t.expiresAt,
      created_at: t.createdAt,
      last_used_at: t.lastUsedAt,
      revoked_at: t.revokedAt,
      tier: t.tier,
      profile_id: t.profileId,
      // token_hash is intentionally NOT returned
    }));
    return c.json({ tokens });
  });

  app.delete('/api-tokens/:id', (c) => {
    const id = c.req.param('id');
    bundle.revokeApiToken.execute(id);
    bundle.audit.execute({
      principal: id,
      tokenType: 'api_token',
      event: 'token_revoked',
      status: 204,
      toolName: null,
      meta: {},
    });
    return c.body(null, 204);
  });

  return app;
}
