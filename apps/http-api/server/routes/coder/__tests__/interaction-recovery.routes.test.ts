import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    getBus: vi.fn(),
    provideUserInput: vi.fn(),
    getRuntimeHandle: vi.fn(),
  },
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));

import type { ServerDeps } from '../../../deps.js';
import { mountCoderInteractionRoutes } from '../interaction.js';
import { mountCoderSpecResponseRoute } from '../spec-response.js';
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
  poolMock.getRuntimeHandle.mockReturnValue(undefined);
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('coder interaction route filesystem recovery', () => {
  it('does not synthesize a retryable tool result when an approval acknowledgement is lost', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Approval ACK loss', provider: 'test', model: 'test' });
    await store.appendMessage({ session_id: session.id, operation_id: 'pending-write', message: {
      role: 'assistant', content: [{ type: 'tool_use', id: 'write-1', name: 'write_file',
        input: { path: 'result.txt', content: 'once' } }],
    } });
    const app = new Hono();
    mountCoderInteractionRoutes(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));
    poolMock.provideUserInput.mockRejectedValueOnce(new Error('worker applied approval; ACK lost'));
    const response = await app.request(`/api/coder/sessions/${session.id}/tool-approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_use_id: 'write-1', approved: true }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'INTERACTION_DELIVERY_UNCONFIRMED' });
    const transcript = await store.loadSessionWithMessages(session.id);
    expect(transcript?.messages).toHaveLength(1);
    expect(transcript?.messages[0].role).toBe('assistant');
  });
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

  it('answers a pending decision_gate from a reopened bundle', async () => {
    // decision_gate was reader-only for a while: nothing checkpointed it, so a
    // reload found no pending interaction and /decide answered 404.
    const session = await store.createSession({
      project_id: 7,
      title: 'Pending decision',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'pending-decision',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'decision-1',
          name: 'decision_gate',
          input: {
            questions: [{
              id: 'strategy',
              question: 'Which approach?',
              options: [
                { label: 'Incremental', value: 'incremental' },
                { label: 'Rewrite', value: 'rewrite' },
              ],
            }],
          },
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
      `/api/coder/sessions/${session.id}/decide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: { strategy: { selected: ['incremental'] } } }),
      },
    );

    expect(response.status).toBe(200);
    const recovered = await store.loadSessionWithMessages(session.id);
    expect(recovered?.messages[1]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'decision-1' }],
    });
  });
});
