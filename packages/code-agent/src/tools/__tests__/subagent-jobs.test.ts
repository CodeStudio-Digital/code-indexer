/**
 * SubagentJobManager — background job bookkeeping. Locks in the concurrency
 * cap, settle idempotence, event-driven waitAny (already-terminal, settle
 * wakeup, timeout, abort, empty, not_found), abortSession, and activity/TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import { SubagentJobManager, type BackgroundAgentSlot } from '@mcp/code-agent/tools/subagent-jobs.js';

const usage: ChatUsage = { input_tokens: 1, output_tokens: 1 };

function slots(n = 1): BackgroundAgentSlot[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, label: `a${i}`, profileId: 'explore', task: 't', status: 'pending' as const, toolCallCount: 0 }));
}

let mgr: SubagentJobManager;
let SID = 0;
beforeEach(() => { mgr = new SubagentJobManager(); SID += 1; });

function mk(jobId: string) {
  return mgr.create({ sessionId: SID, jobId, groupId: jobId, provider: 'p', model: 'm', agents: slots() });
}

describe('SubagentJobManager', () => {
  it('creates jobs and enforces the concurrency cap', () => {
    const prev = process.env.CODER_BACKGROUND_JOBS_MAX;
    process.env.CODER_BACKGROUND_JOBS_MAX = '2';
    try {
      expect('error' in mk('j1')).toBe(false);
      expect('error' in mk('j2')).toBe(false);
      const third = mk('j3');
      expect('error' in third).toBe(true);
    } finally {
      if (prev == null) delete process.env.CODER_BACKGROUND_JOBS_MAX; else process.env.CODER_BACKGROUND_JOBS_MAX = prev;
    }
  });

  it('frees a slot once a job settles', () => {
    const prev = process.env.CODER_BACKGROUND_JOBS_MAX;
    process.env.CODER_BACKGROUND_JOBS_MAX = '1';
    try {
      const j1 = mk('j1');
      if ('error' in j1) throw new Error('unexpected');
      expect('error' in mk('j2')).toBe(true);
      mgr.settle(j1, 'done', usage, 'done');
      expect('error' in mk('j2b')).toBe(false);
    } finally {
      if (prev == null) delete process.env.CODER_BACKGROUND_JOBS_MAX; else process.env.CODER_BACKGROUND_JOBS_MAX = prev;
    }
  });

  it('settle is idempotent', () => {
    const j = mk('j1');
    if ('error' in j) throw new Error('unexpected');
    mgr.settle(j, 'first', usage, 'done');
    mgr.settle(j, 'second', { input_tokens: 9, output_tokens: 9 }, 'aborted');
    expect(j.status).toBe('done');
    expect(j.resultText).toBe('first');
  });

  it('waitAny returns immediately for an already-terminal job', async () => {
    const j = mk('j1');
    if ('error' in j) throw new Error('unexpected');
    mgr.settle(j, 'r', usage, 'done');
    const res = await mgr.waitAny(SID, ['j1'], undefined, 1000);
    expect(res.kind).toBe('done');
  });

  it('waitAny wakes when a running job settles (no polling)', async () => {
    const j = mk('j1');
    if ('error' in j) throw new Error('unexpected');
    const p = mgr.waitAny(SID, ['j1'], undefined, 5000);
    setTimeout(() => mgr.settle(j, 'r', usage, 'done'), 20);
    const res = await p;
    expect(res.kind).toBe('done');
  });

  it('waitAny times out while the job is still running', async () => {
    mk('j1');
    const res = await mgr.waitAny(SID, ['j1'], undefined, 30);
    expect(res.kind).toBe('timeout');
  });

  it('waitAny reports abort via the signal', async () => {
    mk('j1');
    const ac = new AbortController();
    const p = mgr.waitAny(SID, ['j1'], ac.signal, 5000);
    setTimeout(() => ac.abort(), 20);
    expect((await p).kind).toBe('aborted');
  });

  it('waitAny distinguishes empty (no jobs) from not_found (bad id)', async () => {
    expect((await mgr.waitAny(SID, null, undefined, 10)).kind).toBe('empty');
    mk('j1');
    expect((await mgr.waitAny(SID, ['nope'], undefined, 10)).kind).toBe('not_found');
  });

  it('abortSession aborts every running job', () => {
    const j1 = mk('j1'); const j2 = mk('j2');
    if ('error' in j1 || 'error' in j2) throw new Error('unexpected');
    mgr.abortSession(SID, 'user stop');
    expect(j1.abort.signal.aborted).toBe(true);
    expect(j2.abort.signal.aborted).toBe(true);
  });

  it('notifies activity observers on create and settle', () => {
    const seen: number[] = [];
    mgr.onActivity((sid, active) => { if (sid === SID) seen.push(active); });
    const j = mk('j1');
    if ('error' in j) throw new Error('unexpected');
    mgr.settle(j, 'r', usage, 'done');
    expect(seen).toEqual([1, 0]);
  });
});
