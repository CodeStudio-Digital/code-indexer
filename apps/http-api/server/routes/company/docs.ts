/** Read-only projection of the same durable knowledge service used by agent tools. */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import {
  DOCS_MIRROR_PREFIX,
} from '@mcp/company/tools/file-path-core.js';
import {
  parseCompanySessionIdParam,
  resolveCompanySessionContext,
  notFound,
} from '../_helpers.js';
import type { CompanySessionId } from '@mcp/session-storage';

import { CompanyDocs, normalizeDocServiceId, validateDocPath } from '@mcp/company/services/CompanyDocs.js';
export { normalizeDocServiceId } from '@mcp/company/services/CompanyDocs.js';

export function resolveDocsScopeKey(deps: ServerDeps, sessionId: CompanySessionId): string {
  return getMirrorStore(deps, sessionId).resolveScopeKey();
}
function getMirrorStore(deps: ServerDeps, sessionId: CompanySessionId): CompanyDriveStore {
  return new CompanyDriveStore({ sessionStore: deps.sessionStore, companySessionId: sessionId });
}
export async function companyDocs(deps: ServerDeps, sessionId: CompanySessionId, serviceId: string | null): Promise<CompanyDocs> {
  const service = normalizeDocServiceId(serviceId);
  const manager = getSandboxManager();
  const sb = service === 'main' ? manager.get(sessionId) : manager.getService(sessionId, service);
  const binding = sb?.containerId ? {
    driver: await (await import('@mcp/services/sandbox/drivers/driver-factory.js')).resolveDriver().catch(() => null),
    workdir: sb.workdir, containerId: sb.containerId, previewUrl: sb.previewUrl, serviceId: service,
  } : null;
  return new CompanyDocs(getMirrorStore(deps, sessionId), service, binding?.driver ? binding as import('@mcp/company/types.js').SandboxBinding : null);
}
export async function readCompanyDoc(deps: ServerDeps, sessionId: CompanySessionId, serviceId: string | null, path: string) {
  return (await companyDocs(deps, sessionId, serviceId)).read(path);
}

export function mountCompanyDocsRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/docs/list', async (c) => {
    const resolved = await resolveCompanySessionContext(
      deps.sessionStore,
      parseCompanySessionIdParam(c),
    );
    if (!resolved) return notFound(c);
    const id = resolved.rootId;
    const serviceId = c.req.query('service') || null;
    try { normalizeDocServiceId(serviceId); } catch { return c.json({ error: 'invalid service' }, 400); }
    const docs = await companyDocs(deps, id, serviceId);
    const entries = await docs.list();
    const drive = getMirrorStore(deps, id);
    const services = [...new Set(['main', ...drive.list(drive.resolveScopeKey(), { prefix: DOCS_MIRROR_PREFIX }).map((row) => row.path.slice(DOCS_MIRROR_PREFIX.length).split('/')[0]!)])].map((service_id) => ({ service_id, name: service_id }));
    // `items` preserved for older consumers; `entries` carries origin.
    return c.json({ items: entries.map((e) => e.path), entries, services });
  });

  app.get('/api/company/sessions/:id/docs/read', async (c) => {
    const resolved = await resolveCompanySessionContext(
      deps.sessionStore,
      parseCompanySessionIdParam(c),
    );
    if (!resolved) return notFound(c);
    const id = resolved.rootId;
    const serviceId = c.req.query('service') || null;
    const path = c.req.query('path') || '';
    try { validateDocPath(path); } catch { return c.json({ error: 'invalid path' }, 400); }
    try { normalizeDocServiceId(serviceId); } catch { return c.json({ error: 'invalid service' }, 400); }
    const doc = await readCompanyDoc(deps, id, serviceId, path);
    if (!doc) return c.json({ error: `doc not found: ${path}` }, 404);
    return c.json(doc);
  });
}
