import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => ({ getBus: () => null, provideUserInput: async () => false, getRuntimeHandle: () => undefined }),
}));

import type { ServerDeps } from '../../../deps.js';
import { mountCoderInteractionRoutes } from '../interaction.js';
import { createCoderRuntime } from '../state.js';

let temporaryRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'session-fallback-retired-'));
  const dataDir = join(temporaryRoot, 'data');
  const projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) => (projectId === 7 ? projectRoot : null),
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('retired per-session provider fallback', () => {
  it('no longer serves the per-session fallback routes', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Fallback', provider: 'test', model: 'test' });
    const app = new HttpRouter();
    mountCoderInteractionRoutes(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));

    const get = await app.request(`/api/coder/sessions/${session.id}/fallback`);
    const patch = await app.request(`/api/coder/sessions/${session.id}/fallback`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-fallback' }),
    });
    expect(get.status).toBe(404);
    expect(patch.status).toBe(404);
  });

  it('reads a session written with the retired fields and drops them on the next write', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Legacy', provider: 'test', model: 'test' });
    const location = await store.getSessionLocation(session.id);
    await store.repository.updateState(location!, (current) => ({
      ...current,
      extra: {
        ...current.extra,
        runtime: {
          ...((current.extra as { runtime?: Record<string, unknown> }).runtime ?? {}),
          fallback_provider: 'openai',
          fallback_model: 'gpt-fallback',
        },
      },
    }));

    const runtime = await store.getRuntimeSessionState(session.id);
    expect(runtime).not.toHaveProperty('fallback_provider');
    expect(runtime).not.toHaveProperty('fallback_model');
    expect(await store.getSession(session.id)).not.toHaveProperty('fallback_provider');

    await store.setSessionOutputStyle(session.id, 'compact');
    expect(await store.getRuntimeSessionState(session.id)).toMatchObject({ output_style_override: 'compact' });
  });
});
