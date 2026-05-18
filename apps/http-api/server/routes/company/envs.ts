/**
 * Session-scoped env vars shared by every microservice container.
 *
 * Each row is injected at provision time and materialized as
 * `/app/.env` so live dev-servers pick up edits without a restart
 * (`syncEnvsToAllContainers` after every mutation).
 *
 * Secret values are masked in the default list response; pass
 * `?reveal=1` (authenticated operators only — the token/bearer layer
 * already gates the route) to include plaintext values.
 *
 * Phase 8: extracted from `sessions.ts` mega-file.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function mountCompanyEnvsRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, companySessionEnvStore } = deps;

  app.get('/api/company/sessions/:id/envs', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const reveal = c.req.query('reveal') === '1';
    const rows = companySessionEnvStore.list(id);
    return c.json({
      envs: rows.map((r) => ({
        key: r.key,
        value: r.is_secret && !reveal ? '' : r.value,
        is_secret: !!r.is_secret,
        masked: !!r.is_secret && !reveal,
        source: r.source ?? 'user',
        updated_at: r.updated_at,
      })),
    });
  });

  app.put('/api/company/sessions/:id/envs/:key', async (c) => {
    const id = parseIdParam(c);
    const key = c.req.param('key');
    if (!key || !KEY_RE.test(key)) {
      return c.json({ error: `Invalid key '${key}'. Use letters/digits/underscore only.` }, 400);
    }
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const body = await parseJsonBody<{ value?: string; is_secret?: boolean }>(c);
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'value (string) required' }, 400);
    }
    companySessionEnvStore.upsert(id, key, body.value, !!body.is_secret);
    // Push the new .env to any live container so running dev-servers
    // pick up the change without a reprovision. Best-effort — the
    // truthful state is always the DB; live sync is a nicety.
    await getSandboxManager()
      .syncEnvsToAllContainers(String(id))
      .catch(() => void 0);
    return c.json({ ok: true });
  });

  app.delete('/api/company/sessions/:id/envs/:key', async (c) => {
    const id = parseIdParam(c);
    const key = c.req.param('key');
    if (!key) return c.json({ error: 'key required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    companySessionEnvStore.delete(id, key);
    await getSandboxManager()
      .syncEnvsToAllContainers(String(id))
      .catch(() => void 0);
    return c.json({ ok: true });
  });
}
