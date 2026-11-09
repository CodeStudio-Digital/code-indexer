/**
 * Artifact serving routes for the QA Tab.
 *
 * Generalises the v3.0 `/qa/trace` endpoint to serve **any** artefact
 * the Playwright run produces — `.zip`, `.png`, `.webm`, `.mp4`, plus
 * the static `playwright-report/` HTML bundle. Every endpoint accepts
 * `?service=<id>` so callers can pull from a sibling microservice's
 * workdir, not just the primary container.
 *
 * Routes mounted:
 *   GET /qa/artifact?service=&path=        — single file (any allowed mime)
 *   GET /qa/playwright-report?service=&file= — HTML report (rewrites assets)
 *   GET /qa/trace?path=                    — back-compat alias → 308 redirect
 *
 * Security: path whitelist mirrors v3.0 — `tests/e2e/`, `test-results/`,
 * `playwright-report/`. Cap configurable via
 * `MCP_QA_ARTIFACT_MAX_BYTES` (default 200 MiB per v4.2 plan).
 */
import type { Hono } from 'hono';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { ServerDeps } from '../../../deps.js';
import {
  parseSessionIdParam,
} from '../../_helpers.js';
import { isUuid } from '@mcp/session-storage';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { mimeForExtension } from '@mcp/services/qa/parsers/mime-for-extension.js';
import { rewritePlaywrightReportHtml } from '@mcp/services/qa/parsers/rewrite-playwright-report.js';

const ALLOWED_PREFIXES = ['tests/e2e/', 'test-results/', 'playwright-report/'] as const;
const REPORT_PREFIX = 'playwright-report/';
const SERVICE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

function resolveMaxBytes(): number {
  const raw = process.env.MCP_QA_ARTIFACT_MAX_BYTES;
  if (!raw) return 200 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 200 * 1024 * 1024;
  return n;
}

/**
 * Pure: validate an artifact path against the prefix whitelist + the
 * traversal guards. Same shape as the legacy `isAllowedTracePath`,
 * exported for tests.
 */
export function isAllowedArtifactPath(path: string): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false;
  if (path.startsWith('/')) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  if (path.includes('\0')) return false;
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Pure: check a service_id is well-formed (or 'main' / undefined). */
export function isValidServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw === 'main') return true;
  return SERVICE_ID_RE.test(raw);
}

function normaliseService(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return 'main';
  if (!isValidServiceId(raw)) {
    throw new Error('invalid service_id');
  }
  return raw;
}

/**
 * v4.5 — locate a persisted run that contains a given workspace-relative
 * artifact path, optionally hinted by `?run=<id>`. The path itself
 * doesn't carry the runId (the agent passes a workspace-relative
 * `playwright-report/...` URL it generated INSIDE the container), so we
 * pick the most recent persisted run for the session/service that
 * contains the file. Returns null when nothing matches — caller falls
 * back to the live sandbox.
 *
 * Pure-ish: uses `qaTestRunStore.listRuns` + filesystem probes. Cap how many
 * runs we look at so a session with thousands of runs doesn't fan out.
 */
const PERSIST_LOOKUP_LIMIT = 20;

async function findPersistedArtifact(
  deps: Pick<ServerDeps, 'qaTestRunStore'>,
  opts: { sessionId: string; serviceId: string; relPath: string; hintRunId?: string },
): Promise<{ absolute: string; runId: string } | null> {
  const candidates: Array<{ runId: string; persistedPath: string }> = [];
  if (opts.hintRunId) {
    const run = await deps.qaTestRunStore.getRun(opts.hintRunId);
    if (run?.report_persisted_path && run.company_session_id === opts.sessionId) {
      candidates.push({ runId: run.id, persistedPath: run.report_persisted_path });
    }
  }
  if (candidates.length === 0 && !opts.hintRunId) {
    const runs = await deps.qaTestRunStore.listRuns({
      company_session_id: opts.sessionId,
      service_id: opts.serviceId === 'main' ? undefined : opts.serviceId,
      limit: PERSIST_LOOKUP_LIMIT,
    });
    for (const r of runs) {
      if (r.report_persisted_path) {
        candidates.push({ runId: r.id, persistedPath: r.report_persisted_path });
      }
    }
  }
  for (const c of candidates) {
    const absolute = nodePath.join(c.persistedPath, opts.relPath);
    // Defence-in-depth: confirm the resolved path stays inside the
    // persisted run dir (no `..` escaping past the whitelist guard).
    const resolved = nodePath.resolve(absolute);
    const root = nodePath.resolve(c.persistedPath);
    if (!resolved.startsWith(root + nodePath.sep) && resolved !== root) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return { absolute: resolved, runId: c.runId };
    } catch {
      // not in this run; keep looking
    }
  }
  return null;
}

function parseHintRunId(raw: string | undefined): string | undefined {
  return raw && isUuid(raw) ? raw.toLowerCase() : undefined;
}

export function mountQaArtifactRoutes(app: Hono, deps: ServerDeps): void {
  const maxBytes = resolveMaxBytes();

  // GET /qa/artifact?service=&path=&run= — generic single-file serve.
  // v4.5: tries the persisted host copy FIRST (survives sandbox
  // teardown), then falls back to the live sandbox.
  app.get('/api/company/sessions/:id/qa/artifact', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const path = (c.req.query('path') ?? '').replace(/^\/+/, '');
    if (!isAllowedArtifactPath(path)) {
      return c.json(
        { error: 'path must point inside tests/e2e/, test-results/, or playwright-report/' },
        400,
      );
    }
    let serviceId: string;
    try {
      serviceId = normaliseService(c.req.query('service'));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const filename = path.split('/').pop() ?? 'artifact';

    // 1) Persisted host copy (fast + survives sandbox destruction).
    const hintRunId = parseHintRunId(c.req.query('run'));
    const persisted = await findPersistedArtifact(deps, {
      sessionId,
      serviceId,
      relPath: path,
      hintRunId,
    }).catch(() => null);
    if (persisted) {
      try {
        const buf = await fs.readFile(persisted.absolute);
        const view = new Uint8Array(buf.byteLength);
        view.set(buf);
        return c.body(view, 200, {
          'content-type': mimeForExtension(path),
          'content-disposition': `inline; filename="${filename}"`,
          'cache-control': 'no-cache',
          'x-mcp-source': 'persisted',
        });
      } catch {
        // fall through to sandbox
      }
    }

    // 2) Sandbox fallback (works for live runs).
    if (hintRunId) {
      const hinted = await deps.qaTestRunStore.getRun(hintRunId);
      if (!hinted || hinted.company_session_id !== sessionId || hinted.status !== 'running' || hinted.executor === 'preview') {
        return c.json({ error: 'Evidence for this QA run is unavailable; evidence from another run cannot replace it' }, 404);
      }
    }
    try {
      const buf = await getSandboxManager().readWorkspaceFileBufferOnService(
        String(sessionId),
        serviceId,
        path,
        { maxBytes },
      );
      const view = new Uint8Array(buf.byteLength);
      view.set(buf);
      return c.body(view, 200, {
        'content-type': mimeForExtension(path),
        'content-disposition': `inline; filename="${filename}"`,
        'cache-control': 'no-cache',
        'x-mcp-source': 'sandbox',
      });
    } catch (e) {
      // When BOTH persisted lookup AND sandbox fail, sharpen the 404
      // message so the operator knows they're looking at a permanently
      // gone artifact, not a transient miss.
      const msg = e instanceof Error ? e.message : String(e);
      if (/no sandbox|no such file|ENOENT/i.test(msg)) {
        return c.json(
          { error: 'sandbox destroyed and no persisted copy of this artifact' },
          404,
        );
      }
      return errorBody(c, e);
    }
  });

  // GET /qa/playwright-report?service=&file=&run= — HTML/asset serve with rewrite.
  // v4.5: persisted host copy is tried first; sandbox is the fallback.
  app.get('/api/company/sessions/:id/qa/playwright-report', async (c) => {
    const sessionId = parseSessionIdParam(c);
    let serviceId: string;
    try {
      serviceId = normaliseService(c.req.query('service'));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const file = (c.req.query('file') ?? 'index.html').replace(/^\/+/, '');
    const path = file.startsWith(REPORT_PREFIX) ? file : `${REPORT_PREFIX}${file}`;
    if (!isAllowedArtifactPath(path) || !path.startsWith(REPORT_PREFIX)) {
      return c.json({ error: 'file must point inside playwright-report/' }, 400);
    }
    const mime = mimeForExtension(path);
    const renderHtml = (raw: string): string =>
      rewritePlaywrightReportHtml(raw, { sessionId, serviceId, filePath: path });

    // 1) Persisted host copy
    const hintRunId = parseHintRunId(c.req.query('run'));
    const persisted = await findPersistedArtifact(deps, {
      sessionId,
      serviceId,
      relPath: path,
      hintRunId,
    }).catch(() => null);
    if (persisted) {
      try {
        const buf = await fs.readFile(persisted.absolute);
        if (mime.startsWith('text/html')) {
          return c.body(renderHtml(buf.toString('utf8')), 200, {
            'content-type': mime,
            'cache-control': 'no-cache',
            'x-mcp-source': 'persisted',
          });
        }
        const view = new Uint8Array(buf.byteLength);
        view.set(buf);
        return c.body(view, 200, {
          'content-type': mime,
          'cache-control': 'no-cache',
          'x-mcp-source': 'persisted',
        });
      } catch {
        // fall through to sandbox
      }
    }

    // 2) Sandbox fallback
    try {
      const buf = await getSandboxManager().readWorkspaceFileBufferOnService(
        String(sessionId),
        serviceId,
        path,
        { maxBytes },
      );
      // Only HTML gets rewriting — CSS/JS/images pass through.
      if (mime.startsWith('text/html')) {
        return c.body(renderHtml(buf.toString('utf8')), 200, {
          'content-type': mime,
          'cache-control': 'no-cache',
          'x-mcp-source': 'sandbox',
        });
      }
      const view = new Uint8Array(buf.byteLength);
      view.set(buf);
      return c.body(view, 200, {
        'content-type': mime,
        'cache-control': 'no-cache',
        'x-mcp-source': 'sandbox',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no sandbox|no such file|ENOENT/i.test(msg)) {
        return c.json(
          { error: 'sandbox destroyed and no persisted copy of this report' },
          404,
        );
      }
      return errorBody(c, e);
    }
  });

  // GET /qa/trace?path= — legacy alias from v3.0. Permanent redirect to
  // /qa/artifact?service=main. Preserves tooling that hardcoded the old
  // URL (browser bookmarks, agent-generated links pre-v4.2).
  app.get('/api/company/sessions/:id/qa/trace', (c) => {
    const sessionId = parseSessionIdParam(c);
    const path = c.req.query('path') ?? '';
    const sp = new URLSearchParams();
    sp.set('service', 'main');
    sp.set('path', path);
    return c.redirect(
      `/api/company/sessions/${sessionId}/qa/artifact?${sp.toString()}`,
      308,
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorBody(c: any, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no sandbox|service /i.test(msg)) return c.json({ error: 'session has no sandbox / service' }, 404);
  if (/larger|too large|max/i.test(msg)) return c.json({ error: msg }, 413);
  if (/no such file|ENOENT/i.test(msg)) return c.json({ error: 'artifact not found' }, 404);
  if (/invalid service_id/i.test(msg)) return c.json({ error: msg }, 400);
  return c.json({ error: msg }, 500);
}
