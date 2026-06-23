/**
 * Regression — the shared-drive REST routes must return REAL synchronous data
 * (an array of files), even when the session has a LIVE orchestrator.
 *
 * The bug: `getCompanyOrchestrator` returns a `WorkerBackedOrchestrator` RPC
 * proxy whose every method returns a Promise. The route used to do
 * `orchestrator.driveStore.list()` synchronously → got a Promise → Hono
 * serialized it as `{}` → the dashboard saw `files: {}` and threw
 * "Unexpected drive response shape" for any running session. The fix always
 * uses a fresh in-process `CompanyDriveStore` (coherent via SQLite + FS) and
 * only borrows the live session's bus to broadcast mutations over SSE.
 *
 * NOTE: DB-backed (better-sqlite3). In an environment with the native ABI
 * mismatch (ERR_DLOPEN_FAILED 130 vs 127) run `pnpm node:rebuild` first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A live pool entry whose bus captures broadcast events. Returned by the
// mocked singleton so the route takes the "session is live" branch — the
// exact path that used to serialize a Promise.
const fakeBus = { nextSeq: 0, buffer: [] as unknown[], subscribers: new Set() };
let liveEntry: { orchestrator: unknown; bus: typeof fakeBus } | null = null;

vi.mock('../../../../sse/workerPoolSingleton.js', () => ({
  getWorkerOrchestratorPool: () => ({ get: () => liveEntry }),
}));

import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { mountCompanyDriveRoutes } from '../drive.js';
import type { ServerDeps } from '../../../deps.js';

interface Handle {
  app: Hono;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  sessionId: number;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-drive-routes-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);
  const session = companyStore.createCompanySession({ name: 'drive-test', config_json: '{}' });

  const app = new Hono();
  const deps = { db, companyStore } as unknown as ServerDeps;
  mountCompanyDriveRoutes(app, deps);
  return { app, db, companyStore, sessionId: session.id, dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('company /drive routes — synchronous shape regardless of session liveness', () => {
  let h: Handle;
  beforeEach(() => {
    h = setup();
    liveEntry = null;
    fakeBus.buffer.length = 0;
    fakeBus.nextSeq = 0;
  });
  afterEach(() => teardown(h));

  async function listFiles(): Promise<unknown> {
    const r = await h.app.request(`/api/company/sessions/${h.sessionId}/drive`);
    expect(r.status).toBe(200);
    return (await r.json()) as { scope: string; files: unknown };
  }

  it('GET returns files as an ARRAY (not a serialized Promise) when the session is live', async () => {
    liveEntry = { orchestrator: {}, bus: fakeBus };
    const body = (await listFiles()) as { files: unknown };
    expect(Array.isArray(body.files)).toBe(true);
  });

  it('GET works the same when the session is dormant (no pool entry)', async () => {
    liveEntry = null;
    const body = (await listFiles()) as { files: unknown };
    expect(Array.isArray(body.files)).toBe(true);
  });

  it('POST upload persists and broadcasts to the live bus, then GET lists it', async () => {
    liveEntry = { orchestrator: {}, bus: fakeBus };
    const post = await h.app.request(`/api/company/sessions/${h.sessionId}/drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'specs/auth.md', content: '# Auth' }),
    });
    expect(post.status).toBe(200);

    // Mutation broadcast over SSE preserved (file_added on the live bus).
    expect(fakeBus.buffer.length).toBeGreaterThan(0);

    const body = (await listFiles()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toContain('specs/auth.md');
  });
});
