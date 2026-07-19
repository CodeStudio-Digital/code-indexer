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
  const appendCalls: Array<{ id: number; msg: unknown }> = [];
  const bus = opts.live === false ? null : liveBus();
  poolMock.getBus.mockImplementation((id: number) => id === 1 ? bus : null);
  poolMock.isWaitingForInput.mockResolvedValue(!!opts.waiting);
  poolMock.interruptWait.mockResolvedValue(undefined);
  poolMock.pushUserMessage.mockResolvedValue(undefined);

  const deps = {
    sessionStore: {
      appendMessage: (id: number, msg: unknown) => {
        appendCalls.push({ id, msg });
        return 42;
      },
    },
  } as unknown as ServerDeps;
  const runtime = {
    activeRuns: new Map(),
    findPendingInteraction: () => null,
    findDanglingToolUse: () => null,
  } as unknown as CoderRuntime;

  const app = new Hono();
  mountCoderInteractionRoutes(app, deps, runtime);

  const inject = (id: number, body: unknown) =>
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
    const r = await h.inject(1, { content: 'follow-up', selected_skill_ids: ['s1'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(h.appendCalls).toHaveLength(1);
    expect(poolMock.pushUserMessage).toHaveBeenCalledWith(1, 'follow-up', ['s1'], 42);
  });

  it('returns noActiveRun when there is no live run', async () => {
    const h = setup({ live: false });
    const r = await h.inject(1, { content: 'hello' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ noActiveRun: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('400s on empty content', async () => {
    const h = setup({ live: true });
    const r = await h.inject(1, { content: '   ' });
    expect(r.status).toBe(400);
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('returns waiting when blocked and interject is not set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(1, { content: 'hi' });
    expect(await r.json()).toEqual({ waiting: true });
    expect(poolMock.pushUserMessage).not.toHaveBeenCalled();
  });

  it('interrupts the wait and injects when interject is set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(1, { content: 'hi', interject: true });
    expect(await r.json()).toEqual({ injected: true });
    expect(poolMock.interruptWait).toHaveBeenCalledWith(1);
    expect(poolMock.pushUserMessage).toHaveBeenCalledTimes(1);
  });
});
