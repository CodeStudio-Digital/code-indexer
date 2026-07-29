/**
 * Docs read-only proxy.
 *
 * The dashboard's Docs tab fetches markdown files produced by the
 * agents' `docs_*` tools. Routes are read-only on purpose: every write
 * MUST go through the agent tools (so the agents stay the source of
 * truth, and the company drive mirror picks up the change — see
 * `packages/company/src/tools/docs-tools.ts`).
 *
 * Phase D2: the sandbox is still the primary source, but when it is
 * dead (destroyed / restarting) or simply doesn't have the file, both
 * list and read FALL BACK to the durable drive mirror the docs tools
 * maintain under `__docs__/<service>/<path>`. Every payload now carries
 * `origin: 'sandbox' | 'drive_mirror'` so the UI can badge provenance.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import {
  checkRelativePath,
  DOCS_CONTENT_CAP_BYTES,
  DOCS_MIRROR_PREFIX,
} from '@mcp/company/tools/file-path-core.js';
import {
  parseCompanySessionIdParam,
  resolveCompanySessionContext,
  notFound,
} from '../_helpers.js';
import type { CompanySessionId } from '@mcp/session-storage';

export type CompanyDocOrigin = 'sandbox' | 'drive_mirror';

export interface CompanyDocEntry {
  path: string;
  origin: CompanyDocOrigin;
  /** Mirror rows carry the drive's updated_at; sandbox reads have none. */
  mtime: string | null;
}

export interface CompanyDocContent {
  content: string;
  origin: CompanyDocOrigin;
  mtime: string | null;
}

interface DocsBinding {
  workdir: string;
  containerId: string;
}

function resolveDocsBinding(sessionId: CompanySessionId, serviceId: string | null): DocsBinding | null {
  const manager = getSandboxManager();
  if (serviceId) {
    const sb = manager.getService(sessionId, serviceId);
    if (!sb) return null;
    return { workdir: sb.workdir, containerId: sb.containerId };
  }
  const primary = manager.get(sessionId);
  if (!primary) return null;
  return { workdir: primary.workdir, containerId: primary.containerId };
}

/** Same namespace convention as `docs-tools.driveMirrorPath`. */
export function normalizeDocServiceId(serviceId: string | null): string {
  return serviceId && serviceId !== 'main' ? serviceId : 'main';
}
const mirrorSvc = normalizeDocServiceId;

/**
 * Scope key of the session's drive (`tpl:<id>` / `ses:<rootId>`) — the
 * docs-RAG bridge uses it to namespace collection names and source URIs.
 */
export function resolveDocsScopeKey(deps: ServerDeps, sessionId: CompanySessionId): string {
  return getMirrorStore(deps, sessionId).resolveScopeKey();
}

/**
 * Read-only mirror store — instantiated fresh per request like the
 * drive routes do; no publisher because these routes never mutate.
 */
function getMirrorStore(deps: ServerDeps, sessionId: CompanySessionId): CompanyDriveStore {
  return new CompanyDriveStore({
    sessionStore: deps.sessionStore,
    companySessionId: sessionId,
  });
}

async function listSandboxDocs(binding: DocsBinding): Promise<string[]> {
  const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
  const driver = await resolveDriver();
  const probe = await driver.exec(
    binding.containerId,
    `cd ${binding.workdir}/docs 2>/dev/null && find . -type f \\( -name '*.md' -o -name 'index.json' \\) 2>/dev/null | sed 's|^\\./||' || true`,
    { cwd: binding.workdir, timeoutMs: 5_000 },
  );
  return probe.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function listMirrorDocs(deps: ServerDeps, sessionId: CompanySessionId, serviceId: string | null): CompanyDocEntry[] {
  const drive = getMirrorStore(deps, sessionId);
  const prefix = `${DOCS_MIRROR_PREFIX}${mirrorSvc(serviceId)}/`;
  return drive.list(drive.resolveScopeKey(), { prefix }).map((meta) => ({
    path: meta.path.slice(prefix.length),
    origin: 'drive_mirror' as const,
    mtime: meta.updatedAt,
  }));
}

/**
 * Merged doc listing: sandbox entries win over mirror entries with the
 * same path (the container copy is the live one); mirror-only entries
 * keep the docs browsable after a sandbox destroy/restart.
 */
export async function listCompanyDocs(
  deps: ServerDeps,
  sessionId: CompanySessionId,
  serviceId: string | null,
): Promise<CompanyDocEntry[]> {
  const binding = resolveDocsBinding(sessionId, serviceId);
  const byPath = new Map<string, CompanyDocEntry>();
  for (const entry of listMirrorDocs(deps, sessionId, serviceId)) {
    byPath.set(entry.path, entry);
  }
  if (binding) {
    try {
      for (const path of await listSandboxDocs(binding)) {
        byPath.set(path, { path, origin: 'sandbox', mtime: null });
      }
    } catch {
      // Sandbox listed as alive but exec failed (mid-restart) — the
      // mirror entries already collected keep the tab functional.
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read one doc: sandbox first, mirror as fallback (dead sandbox OR the
 * file is simply absent from the container). Null when neither has it.
 */
export async function readCompanyDoc(
  deps: ServerDeps,
  sessionId: CompanySessionId,
  serviceId: string | null,
  path: string,
): Promise<CompanyDocContent | null> {
  const binding = resolveDocsBinding(sessionId, serviceId);
  if (binding) {
    try {
      const { resolveDriver } = await import('@mcp/services/sandbox/drivers/driver-factory.js');
      const driver = await resolveDriver();
      const text = await driver.readFile(binding.containerId, `${binding.workdir}/docs/${path}`);
      return { content: text, origin: 'sandbox', mtime: null };
    } catch {
      // fall through to the mirror
    }
  }
  try {
    const drive = getMirrorStore(deps, sessionId);
    const mirrorPath = `${DOCS_MIRROR_PREFIX}${mirrorSvc(serviceId)}/${path}`;
    const result = drive.read(drive.resolveScopeKey(), mirrorPath, {
      maxBytes: DOCS_CONTENT_CAP_BYTES,
    });
    return { content: result.content, origin: 'drive_mirror', mtime: result.meta.updatedAt };
  } catch {
    return null;
  }
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
    const entries = await listCompanyDocs(deps, id, serviceId);
    // `items` preserved for older consumers; `entries` carries origin.
    return c.json({ items: entries.map((e) => e.path), entries });
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
    if (!checkRelativePath(path, { traversal: 'substring' }).ok) {
      return c.json({ error: 'invalid path' }, 400);
    }
    const doc = await readCompanyDoc(deps, id, serviceId, path);
    if (!doc) return c.json({ error: `doc not found: ${path}` }, 404);
    return c.json(doc);
  });
}
