/**
 * Phase D2 — the Docs routes must survive a dead sandbox by falling
 * back to the drive mirror (`__docs__/<service>/<path>`) the docs tools
 * maintain, and every payload must carry `origin` so the dashboard can
 * badge provenance.
 *
 * NOTE: DB-backed (better-sqlite3). In an environment with the native
 * ABI mismatch (ERR_DLOPEN_FAILED 130 vs 127) run `pnpm node:rebuild`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable sandbox state — null = dead (no container for the session).
let sandboxBinding: { workdir: string; containerId: string } | null = null;
// When the sandbox is "alive", these drive the fake driver.
let execImpl: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
let readFileImpl: () => Promise<string>;

vi.mock('@mcp/services/sandbox/index.js', () => ({
  getSandboxManager: () => ({
    get: () => sandboxBinding,
    getService: () => sandboxBinding,
  }),
}));

vi.mock('@mcp/services/sandbox/drivers/driver-factory.js', () => ({
  resolveDriver: async () => ({
    exec: () => execImpl(),
    readFile: () => readFileImpl(),
  }),
}));

import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import { mountCompanyDocsRoutes } from '../docs.js';
import type { ServerDeps } from '../../../deps.js';

interface Handle {
  app: Hono;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  sessionId: number;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-docs-routes-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);
  const session = companyStore.createCompanySession({ name: 'docs-test', config_json: '{}' });

  const app = new Hono();
  const deps = { db, companyStore } as unknown as ServerDeps;
  mountCompanyDocsRoutes(app, deps);
  return { app, db, companyStore, sessionId: session.id, dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seedMirror(h: Handle, path: string, content: string): void {
  const drive = new CompanyDriveStore({
    db: h.db,
    companyStore: h.companyStore,
    companySessionId: h.sessionId,
  });
  drive.write(drive.resolveScopeKey(), `__docs__/main/${path}`, content);
}

describe('company /docs routes — drive-mirror fallback (D2)', () => {
  let h: Handle;
  beforeEach(() => {
    h = setup();
    sandboxBinding = null;
    execImpl = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    readFileImpl = async () => { throw new Error('no such file'); };
  });
  afterEach(() => teardown(h));

  it('list falls back to the mirror when the sandbox is dead', async () => {
    seedMirror(h, 'adr/0001-auth.md', '# ADR 1');
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/docs/list`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: string[]; entries: Array<{ path: string; origin: string; mtime: string | null }> };
    expect(body.items).toContain('adr/0001-auth.md');
    const entry = body.entries.find((e) => e.path === 'adr/0001-auth.md')!;
    expect(entry.origin).toBe('drive_mirror');
    expect(entry.mtime).toBeTruthy();
  });

  it('read falls back to the mirror when the sandbox is dead', async () => {
    seedMirror(h, 'adr/0001-auth.md', '# ADR 1');
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=${encodeURIComponent('adr/0001-auth.md')}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string; origin: string; mtime: string | null };
    expect(body.content).toBe('# ADR 1');
    expect(body.origin).toBe('drive_mirror');
  });

  it('read falls back to the mirror when the sandbox is alive but lacks the file', async () => {
    sandboxBinding = { workdir: '/work', containerId: 'c1' };
    readFileImpl = async () => { throw new Error('ENOENT'); };
    seedMirror(h, 'runbook.md', '# Runbook');
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=runbook.md`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string; origin: string };
    expect(body.content).toBe('# Runbook');
    expect(body.origin).toBe('drive_mirror');
  });

  it('sandbox wins the list merge when both have the same path', async () => {
    sandboxBinding = { workdir: '/work', containerId: 'c1' };
    execImpl = async () => ({ stdout: 'runbook.md\n', stderr: '', exitCode: 0 });
    seedMirror(h, 'runbook.md', '# old mirror copy');
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/docs/list`);
    const body = (await r.json()) as { entries: Array<{ path: string; origin: string }> };
    const entries = body.entries.filter((e) => e.path === 'runbook.md');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.origin).toBe('sandbox');
  });

  it('read 404s when neither the sandbox nor the mirror has the doc', async () => {
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=missing.md`,
    );
    expect(r.status).toBe(404);
  });

  it('read rejects traversal paths', async () => {
    const r = await h.app.request(
      `/api/company/sessions/${h.sessionId}/docs/read?path=${encodeURIComponent('../etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });
});
