/**
 * Unit test for POST /api/coder/sessions/:id/inject (mandatory worker path).
 *
 * Mounts the coder interaction routes with STUB sessionStore + runtime (no DB,
 * no real worker) so it's ABI-free. The worker pool RPC surface is mocked.
 * Validates the three outcomes the dashboard queue depends on:
 * injected (live run), noActiveRun (no run → client falls back to /messages),
 * and the empty-content 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asSessionId, type SessionId } from '@mcp/agent-runtime-contracts';

const SESSION_ID = asSessionId('22222222-2222-4222-8222-222222222222');

const { poolMock } = vi.hoisted(() => ({
  poolMock: {
    getBus: vi.fn(),
    isWaitingForInput: vi.fn(),
    interruptWait: vi.fn(),
    pushUserMessage: vi.fn(),
  },
}));

vi.mock('../../../../sse/coderWorkerPoolSingleton.js', () => ({
  getCoderWorkerPool: () => poolMock,
}));

import { mountCoderInteractionRoutes } from '../interaction.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function liveBus() {
  // Shape `emitWorkerLog`/`publish` touch (nextSeq/buffer/subscribers) plus the
  // fields /inject and worker logging read.
  return { ended: false, nextSeq: 0, buffer: [] as unknown[], subscribers: new Set(), eventSinks: [] as unknown[] };
}

function setup(opts: { live?: boolean; waiting?: boolean } = {}) {
  const appendCalls: Array<{
    session_id: SessionId;
    operation_id: string;
    message: unknown;
  }> = [];
  const bus = opts.live === false ? null : liveBus();
  poolMock.getBus.mockImplementation((id: SessionId) => id === SESSION_ID ? bus : null);
  poolMock.isWaitingForInput.mockResolvedValue(!!opts.waiting);
  poolMock.interruptWait.mockResolvedValue(undefined);
  poolMock.pushUserMessage.mockResolvedValue(42);

  const deps = {
    sessionStore: {
      appendMessage: async (input: {
        session_id: SessionId;
        operation_id: string;
        message: unknown;
      }) => {
        appendCalls.push(input);
        return 42;
      },
    },
  } as unknown as ServerDeps;
  const runtime = {
    activeRuns: new Map(),
    findPendingInteraction: async () => null,
    findDanglingToolUse: async () => null,
  } as unknown as CoderRuntime;

  const app = new Hono();
  mountCoderInteractionRoutes(app, deps, runtime);

  const inject = (id: SessionId, body: unknown) =>
    app.request(`/api/coder/sessions/${id}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return { inject, appendCalls };
}

beforeEach(() => vi.clearAllMocks());

describe('coder POST /sessions/:id/inject', () => {
  it('enqueues into a live run and returns injected', async () => {
    const h = setup({ live: true });
    const r = await h.inject(SESSION_ID, { content: 'follow-up', selected_skill_ids: ['s1'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(
      SESSION_ID,
      'follow-up',
      ['s1'],
      expect.stringMatching(/^interaction:inject:/),
    );
  });

  it('returns noActiveRun when there is no live run', async () => {
    const h = setup({ live: false });
    const r = await h.inject(SESSION_ID, { content: 'hello' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ noActiveRun: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('400s on empty content', async () => {
    const h = setup({ live: true });
    const r = await h.inject(SESSION_ID, { content: '   ' });
    expect(r.status).toBe(400);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('returns waiting when blocked and interject is not set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(SESSION_ID, { content: 'hi' });
    expect(await r.json()).toEqual({ waiting: true });
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('interrupts the wait and injects when interject is set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(SESSION_ID, { content: 'hi', interject: true });
    expect(await r.json()).toEqual({ injected: true });
    expect(poolMock.interruptWait).toHaveBeenCalledWith(SESSION_ID);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);
  });
});
