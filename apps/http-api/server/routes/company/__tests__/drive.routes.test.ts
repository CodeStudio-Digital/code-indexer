/**
 * Regression — the shared-drive REST routes must return REAL synchronous data
 * (an array of files), even when the session has a LIVE orchestrator.
 *
 * The bug: `getCompanyOrchestrator` returns a `WorkerBackedOrchestrator` RPC
 * proxy whose every method returns a Promise. The route used to do
 * `orchestrator.driveStore.list()` synchronously → got a Promise → Hono
 * serialized it as `{}` → the dashboard saw `files: {}` and threw
 * "Unexpected drive response shape" for any running session. The fix always
 * uses a fresh in-process `CompanyDriveStore` over the session bundle and
 * only borrows the live session's bus to broadcast mutations over SSE.
 *
 * The fixture is filesystem-only and never opens SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type { JsonValue } from '@mcp/session-storage';
import { mountCompanyDriveRoutes } from '../drive.js';
import type { ServerDeps } from '../../../deps.js';

interface Handle {
  app: Hono;
  sessionStore: FsSessionStore;
  sessionId: string;
  dir: string;
}

async function setup(): Promise<Handle> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-drive-routes-'));
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const sessionStore = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: 7,
        root_path: projectRoot,
      }],
    },
    projectInfoResolver: (projectId) =>
      projectId === 7
        ? { project_id: 7, name: 'Drive', root_path: projectRoot }
        : null,
  });
  const session = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 7 },
    owner_project_id: 7,
    linked_projects: [{ project_id: 7, root_path: projectRoot }],
    title: 'drive-test',
    status: 'idle',
    metadata: {
      company: {
        name: 'drive-test',
        template_id: null,
        runtime_kind: 'company',
        config_json: '{}',
        master_session_id: null,
        project_labels: { 7: null },
        recovered_at: null,
        recovered_reason: null,
      },
    } as unknown as Record<string, JsonValue>,
  });
  await sessionStore.refresh();

  const app = new Hono();
  const deps = { sessionStore } as unknown as ServerDeps;
  mountCompanyDriveRoutes(app, deps);
  return {
    app,
    sessionStore,
    sessionId: session.session.id,
    dir,
  };
}

function teardown(h: Handle): void {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('company /drive routes — synchronous shape regardless of session liveness', () => {
  let h: Handle;
  beforeEach(async () => {
    h = await setup();
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
