import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    getBus: vi.fn(),
    provideUserInput: vi.fn(),
  },
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));

import type { ServerDeps } from '../../../deps.js';
import { mountCoderInteractionRoutes } from '../interaction.js';
import { createCoderRuntime } from '../state.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  temporaryRoot = await mkdtemp(join(tmpdir(), 'interaction-recovery-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
  poolMock.getBus.mockReturnValue(null);
  poolMock.provideUserInput.mockResolvedValue(false);
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('coder interaction route filesystem recovery', () => {
  it('answers a pending ask_user from a reopened bundle', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Pending answer',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'pending-question',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'question-1',
          name: 'ask_user',
          input: { question: 'Continue?' },
        }],
      },
    });
    await store.close();
    store = openStore();

    const app = new Hono();
    mountCoderInteractionRoutes(
      app,
      { sessionStore: store } as unknown as ServerDeps,
      createCoderRuntime(store),
    );

    const response = await app.request(
      `/api/coder/sessions/${session.id}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'yes' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      resumed_via_worker: true,
    });
    const recovered = await store.loadSessionWithMessages(session.id);
    expect(recovered?.messages).toHaveLength(2);
    expect(recovered?.messages[1]).toMatchObject({
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: 'question-1',
      }],
    });
  });
});
