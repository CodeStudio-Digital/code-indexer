import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEC_APPROVAL_REMINDER } from '@mcp/code-agent/tools/spec/index.js';
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
  it('transports the explicit recovery review and exact fingerprint without resolving storage in the route', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Recovery transport', provider: 'test', model: 'test' });
    const app = new HttpRouter();
    mountCoderInteractionRoutes(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));
    poolMock.provideUserInput.mockResolvedValueOnce(true);
    const response = await app.request(`/api/coder/sessions/${session.id}/tool-approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_use_id: 'pending-write', approved: true, recovery_reviewed: true,
        recovery_fingerprint: 'exact-displayed-fingerprint', always_allow: false }),
    });
    expect(response.status).toBe(200);
    expect(poolMock.provideUserInput).toHaveBeenCalledWith(session.id, expect.any(String), 'tool_approval:pending-write');
    expect(JSON.parse(poolMock.provideUserInput.mock.calls[0][1])).toMatchObject({ approved: true,
      recoveryReviewed: true, recoveryFingerprint: 'exact-displayed-fingerprint', alwaysAllow: false });
    expect((await store.getToolOutcomeState(session.id)).resolved).toEqual([]);
  });

  it('does not convert malformed boolean strings into approval, a permanent grant or recovery review', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Strict approval transport', provider: 'test', model: 'test' });
    const app = new HttpRouter();
    mountCoderInteractionRoutes(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));
    poolMock.provideUserInput.mockResolvedValueOnce(true);
    const response = await app.request(`/api/coder/sessions/${session.id}/tool-approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_use_id: 'pending-write', approved: 'false', always_allow: 'false',
        recovery_reviewed: 'true', recovery_fingerprint: { forged: true } }),
    });
    if (response.status < 400) {
      const payload = JSON.parse(poolMock.provideUserInput.mock.calls[0][1]);
      expect(payload.approved).toBe(false);
      expect(payload.alwaysAllow).toBe(false);
      expect(payload.recoveryReviewed).toBe(false);
      expect(payload.recoveryFingerprint).toBeUndefined();
    } else expect(poolMock.provideUserInput).not.toHaveBeenCalled();
  });

  it('does not turn a retried approval after lost ACK and runner death into proof of non-execution', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Repeated lost approval ACK', provider: 'test', model: 'test' });
    await store.appendMessage({ session_id: session.id, operation_id: 'pending-once', message: {
      role: 'assistant', content: [{ type: 'tool_use', id: 'write-once', name: 'write_file', input: { path: 'fixture.txt', content: 'once' } }],
    } });
    const app = new HttpRouter();
    mountCoderInteractionRoutes(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));
    poolMock.provideUserInput.mockRejectedValueOnce(new Error('approval dispatched; ACK deadline elapsed')).mockResolvedValueOnce(false);
    const send = () => app.request(`/api/coder/sessions/${session.id}/tool-approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_use_id: 'write-once', approved: true, recovery_reviewed: true, recovery_fingerprint: 'displayed-old-set' }),
    });
    expect((await send()).status).toBe(503);
    await send();
    const transcript = (await store.loadAllSessionMessages(session.id))!;
    const results = transcript.messages.filter(message => message.role === 'tool').flatMap(message => message.content);
    for (const result of results) {
      expect(result).toMatchObject({ type: 'tool_result', effect_outcome: 'unknown' });
      expect(JSON.stringify(result)).not.toContain('NÃO foi executada');
      expect(JSON.stringify(result)).not.toContain('Chame a ferramenta novamente');
    }
    expect((await store.getToolOutcomeState(session.id)).resolved).toEqual([]);
  });

  it('does not synthesize a retryable tool result when an approval acknowledgement is lost', async () => {
    const session = await store.createSession({ project_id: 7, title: 'Approval ACK loss', provider: 'test', model: 'test' });
    await store.appendMessage({ session_id: session.id, operation_id: 'pending-write', message: {
      role: 'assistant', content: [{ type: 'tool_use', id: 'write-1', name: 'write_file',
        input: { path: 'result.txt', content: 'once' } }],
    } });
    const app = new HttpRouter();
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

    const app = new HttpRouter();
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

  it.each([undefined, '.mcp/specs/tiered-cache.md'])('resumes approved Spec in Build with the same guidance as the live runner (path %s)', async (path) => {
    const session = await store.createSession({ project_id: 7, title: 'Pending spec', provider: 'test', model: 'test' });
    await store.setSessionAgent(session.id, 'spec');
    await store.appendMessage({
      session_id: session.id, operation_id: 'pending-spec',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'spec-1', name: 'submit_spec', input: { name: 'Tiered cache' } }] },
    });
    await store.close();
    store = openStore();
    const app = new HttpRouter();
    mountCoderSpecResponseRoute(app, { sessionStore: store } as unknown as ServerDeps, createCoderRuntime(store));

    const response = await app.request(`/api/coder/sessions/${session.id}/spec-response`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, spec_path: path }),
    });
    expect(response.status).toBe(200);
    expect((await store.getSession(session.id))?.agent).toBe('build');
    const recovered = await store.loadSessionWithMessages(session.id);
    expect(recovered?.messages[1]).toMatchObject({ role: 'tool', content: [{
      type: 'tool_result', tool_use_id: 'spec-1',
      content: expect.stringContaining(path ? 'approved by user at ' + path : 'approved by user.'),
    }] });
    expect(recovered?.messages[2]).toMatchObject({
      role: 'user', content: [{ type: 'text', text: SPEC_APPROVAL_REMINDER }],
    });
    expect(SPEC_APPROVAL_REMINDER).not.toContain('submit_tasks');
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

    const app = new HttpRouter();
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
