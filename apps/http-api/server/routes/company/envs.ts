/**
 * Session-scoped env vars shared by every microservice container.
 *
 * Each row is injected at provision time and materialized as
 * `/app/.env` so live dev-servers pick up edits without a restart
 * (`syncEnvsToAllContainers` after every mutation).
 *
 * Secret values are masked in the default list response; pass
 * `?reveal=1` (authenticated operators only — the token/bearer layer
 * already gates the route) to include plaintext values. Values are
 * stored/returned as PLAINTEXT by design — containers need them raw;
 * the mitigation is masking + the reveal AUDIT below (structured log
 * + a board post so agents/operators can see config was exposed).
 * `?key=NAME` narrows the listing (per-row reveal keeps the audit
 * scoped to the single key actually shown).
 *
 * `service_scope` (D1, migration 192): NULL = all services, else CSV of
 * service ids ('main' = primary). Ids are free-form ON PURPOSE — not
 * validated against live services, since services churn and a dangling
 * id is harmless (var reaches no container until the id re-appears).
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
    const keyFilter = c.req.query('key');
    const all = companySessionEnvStore.list(id);
    const rows = keyFilter ? all.filter((r) => r.key === keyFilter) : all;
    if (reveal) {
      const secretKeys = rows.filter((r) => r.is_secret).map((r) => r.key);
      if (secretKeys.length > 0) {
        // Reveal audit (D1): plaintext secrets left the store. Structured
        // log for operators + a board post so the exposure is visible in
        // the session timeline (postToBoard is already wired — cheap).
        console.warn(
          `[env-audit] session ${id}: ?reveal=1 returned plaintext secrets — keys: ${secretKeys.join(', ')}`,
        );
        try {
          companyStore.postToBoard(
            id, 'system', null, 'message',
            `Env secret value(s) revealed in the dashboard: ${secretKeys.join(', ')}`,
          );
        } catch { /* audit post is best-effort; the warn above always lands */ }
      }
    }
    return c.json({
      envs: rows.map((r) => ({
        key: r.key,
        value: r.is_secret && !reveal ? '' : r.value,
        is_secret: !!r.is_secret,
        masked: !!r.is_secret && !reveal,
        source: r.source ?? 'user',
        service_scope: r.service_scope ?? null,
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
    const body = await parseJsonBody<{
      value?: string;
      is_secret?: boolean;
      service_scope?: string | null;
    }>(c);
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'value (string) required' }, 400);
    }
    // Tri-state: absent → keep existing scope; null → all services;
    // string → CSV of service ids (free-form, normalized in the store).
    if (
      'service_scope' in body &&
      body.service_scope !== null &&
      typeof body.service_scope !== 'string'
    ) {
      return c.json({ error: 'service_scope must be null or a CSV string of service ids' }, 400);
    }
    companySessionEnvStore.upsert(id, key, body.value, !!body.is_secret, {
      serviceScope: 'service_scope' in body ? body.service_scope : undefined,
    });
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
