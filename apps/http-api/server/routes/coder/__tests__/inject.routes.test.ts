/**
 * Unit test for POST /api/coder/sessions/:id/inject (legacy in-process path).
 *
 * Mounts the coder interaction routes with STUB sessionStore + runtime (no DB,
 * no worker) so it's ABI-free. `coderWorkerEnabled()` is false without
 * MCP_CODER_WORKER=1, so the route takes the legacy branch and pokes the stub
 * runner directly. Validates the three outcomes the dashboard queue depends on:
 * injected (live run), noActiveRun (no run → client falls back to /messages),
 * and the empty-content 400.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountCoderInteractionRoutes } from '../interaction.js';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';

function liveBus(runner: unknown) {
  // Shape `emitWorkerLog`/`publish` touch (nextSeq/buffer/subscribers) plus the
  // fields /inject reads (ended/runner).
  return { ended: false, nextSeq: 0, buffer: [] as unknown[], subscribers: new Set(), eventSinks: [] as unknown[], runner };
}

function setup(opts: { live?: boolean; waiting?: boolean } = {}) {
  const appendCalls: Array<{ id: number; msg: unknown }> = [];
  const pushCalls: Array<{ content: string; extras: unknown }> = [];
  let interruptCalls = 0;
  const runner = {
    isWaitingForInput: () => !!opts.waiting,
    interruptWait: () => { interruptCalls++; return true; },
    pushUserMessage: (content: string, extras: unknown) => { pushCalls.push({ content, extras }); },
  };
  const activeRuns = new Map<number, unknown>();
  if (opts.live !== false) activeRuns.set(1, liveBus(runner));

  const deps = {
    sessionStore: {
      appendMessage: (id: number, msg: unknown) => {
        appendCalls.push({ id, msg });
        return 42;
      },
    },
  } as unknown as ServerDeps;
  const runtime = {
    activeRuns,
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

  return { inject, appendCalls, pushCalls, get interruptCalls() { return interruptCalls; } };
}

describe('coder POST /sessions/:id/inject', () => {
  it('enqueues into a live run and returns injected', async () => {
    const h = setup({ live: true });
    const r = await h.inject(1, { content: 'follow-up', selected_skill_ids: ['s1'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ injected: true });
    expect(h.appendCalls).toHaveLength(1);
    expect(h.pushCalls).toEqual([{
      content: 'follow-up',
      extras: { selectedSkillIds: ['s1'], roundMessageId: 42 },
    }]);
  });

  it('returns noActiveRun when there is no live run', async () => {
    const h = setup({ live: false });
    const r = await h.inject(1, { content: 'hello' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ noActiveRun: true });
    expect(h.appendCalls).toHaveLength(0);
    expect(h.pushCalls).toHaveLength(0);
  });

  it('400s on empty content', async () => {
    const h = setup({ live: true });
    const r = await h.inject(1, { content: '   ' });
    expect(r.status).toBe(400);
    expect(h.pushCalls).toHaveLength(0);
  });

  it('returns waiting when blocked and interject is not set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(1, { content: 'hi' });
    expect(await r.json()).toEqual({ waiting: true });
    expect(h.pushCalls).toHaveLength(0);
  });

  it('interrupts the wait and injects when interject is set', async () => {
    const h = setup({ live: true, waiting: true });
    const r = await h.inject(1, { content: 'hi', interject: true });
    expect(await r.json()).toEqual({ injected: true });
    expect(h.interruptCalls).toBe(1);
    expect(h.pushCalls).toHaveLength(1);
  });
});
