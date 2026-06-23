/**
 * Docs read-only proxy.
 *
 * The dashboard's Docs tab fetches markdown files produced by the
 * agents' `docs_*` tools. Routes are read-only on purpose: every write
 * MUST go through the agent tools (so the agents stay the source of
 * truth, and the company drive mirror picks up the change — see
 * `packages/company/src/tools/docs-tools.ts`).
 *
 * Phase 8: extracted from `sessions.ts` mega-file. The helper that
 * resolves the right sandbox binding (primary vs. named service) lives
 * inline here since this is the only consumer.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { parseIdParam, notFound } from '../_helpers.js';

interface DocsBinding {
  workdir: string;
  containerId: string;
}

function resolveDocsBinding(sessionId: number, serviceId: string | null): DocsBinding | null {
  const manager = getSandboxManager();
  if (serviceId) {
    const sb = manager.getService(String(sessionId), serviceId);
    if (!sb) return null;
    return { workdir: sb.workdir, containerId: sb.containerId };
  }
  const primary = manager.get(String(sessionId));
  if (!primary) return null;
  return { workdir: primary.workdir, containerId: primary.containerId };
}

export function mountCompanyDocsRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.get('/api/company/sessions/:id/docs/list', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const serviceId = c.req.query('service') || null;
    const binding = resolveDocsBinding(id, serviceId);
    if (!binding) return c.json({ error: 'No sandbox' }, 404);
    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();
    const probe = await driver.exec(
      binding.containerId,
      `cd ${binding.workdir}/docs 2>/dev/null && find . -type f \\( -name '*.md' -o -name 'index.json' \\) 2>/dev/null | sed 's|^\\./||' || true`,
      { cwd: binding.workdir, timeoutMs: 5_000 },
    );
    const items = probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean).sort();
    return c.json({ items });
  });

  app.get('/api/company/sessions/:id/docs/read', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const serviceId = c.req.query('service') || null;
    const path = c.req.query('path') || '';
    if (!path || path.includes('..') || path.startsWith('/') || path.includes('\0')) {
      return c.json({ error: 'invalid path' }, 400);
    }
    const binding = resolveDocsBinding(id, serviceId);
    if (!binding) return c.json({ error: 'No sandbox' }, 404);
    const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
    const driver = await resolveDriver();
    try {
      const abs = `${binding.workdir}/docs/${path}`;
      const text = await driver.readFile(binding.containerId, abs);
      return c.text(text);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });
}
