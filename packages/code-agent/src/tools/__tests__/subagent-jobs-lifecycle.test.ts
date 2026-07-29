/**
 * subagent-jobs-lifecycle — completion notice + wake-on-complete parking.
 * Asserts the notice format, that a settled job wakes the park with 'work'
 * and injects the notice exactly once, and that a user message / abort /
 * timeout each resolve the park correctly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import { SubagentJobManager, type BackgroundAgentSlot } from '@mcp/code-agent/tools/subagent-jobs.js';
import { renderCompletionNotice, parkForBackgroundWork } from '@mcp/code-agent/tools/subagent-jobs-lifecycle.js';
import { newSessionId, type SessionId } from '@mcp/session-storage';

const usage: ChatUsage = { input_tokens: 1, output_tokens: 1 };

function slots(): BackgroundAgentSlot[] {
  return [
    { index: 0, label: 'auth', profileId: 'explore', task: 't', status: 'completed', toolCallCount: 5, summary: 'JWT verified in verify.ts' },
    { index: 1, label: 'db', profileId: 'explore', task: 't', status: 'partial', toolCallCount: 3, summary: 'pool inspected until budget' },
    { index: 2, label: 'api', profileId: 'explore', task: 't', status: 'error', toolCallCount: 2, summary: 'provider failed' },
  ];
}

let mgr: SubagentJobManager;
let SID: SessionId;
beforeEach(() => {
  mgr = new SubagentJobManager();
  SID = newSessionId();
});

function runningJob() {
  const j = mgr.create({ sessionId: SID, jobId: 'job-1', groupId: 'g1', provider: 'p', model: 'm', agents: slots() });
  if ('error' in j) throw new Error('unexpected');
  return j;
}

describe('renderCompletionNotice', () => {
  it('summarizes counts, per-agent digests, and the collect/resume hints', () => {
    const j = runningJob();
    j.resumableCount = 2;
    const text = renderCompletionNotice(j);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('job job-1 (3 agents): 1 completed, 1 partial, 1 failed');
    expect(text).toContain('auth (explore): completed, 5 tools — "JWT verified in verify.ts"');
    expect(text).toContain('collect_agents({job_id:"job-1"})');
    expect(text).toContain('resume_agent({spawn_id:"g1"})'); // has a failure
  });
});

describe('parkForBackgroundWork', () => {
  const base = (over: Partial<Parameters<typeof parkForBackgroundWork>[0]>) => ({
    manager: mgr,
    sessionId: SID,
    signal: new AbortController().signal,
    capMs: 5000,
    waitForMessage: () => new Promise<void>(() => {}),
    hasPendingMessage: () => false,
    pushNotice: () => {},
    ...over,
  });

  it('returns "message" immediately when one is already queued', async () => {
    runningJob();
    const r = await parkForBackgroundWork(base({ hasPendingMessage: () => true }));
    expect(r).toBe('message');
  });

  it('wakes with "work" and injects the notice once when a job settles', async () => {
    const j = runningJob();
    const pushed: string[] = [];
    const persisted: string[] = [];
    setTimeout(() => mgr.settle(j, 'RESULT', usage, 'done'), 15);
    const r = await parkForBackgroundWork(base({ pushNotice: (t) => pushed.push(t), persistNotice: (t) => persisted.push(t) }));
    expect(r).toBe('work');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('background agents finished');
    expect(persisted).toHaveLength(1);
    expect(j.delivery).toBe('notified');
  });

  it('a sole already-notified job leaves nothing pending → timeout, no re-inject', async () => {
    const j = runningJob();
    mgr.settle(j, 'RESULT', usage, 'done');
    mgr.markDelivery(j, 'notified');
    const pushed: string[] = [];
    // Nothing running and nothing undelivered → park has nothing to wait for.
    const r = await parkForBackgroundWork(base({ capMs: 30, pushNotice: (t) => pushed.push(t) }));
    expect(r).toBe('timeout');
    expect(pushed).toHaveLength(0);
  });

  it('returns "message" when the user speaks during the park', async () => {
    runningJob();
    const r = await parkForBackgroundWork(base({ waitForMessage: () => new Promise<void>((res) => setTimeout(res, 15)) }));
    expect(r).toBe('message');
  });

  it('returns "aborted" when the run signal aborts', async () => {
    runningJob();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 15);
    const r = await parkForBackgroundWork(base({ signal: ac.signal }));
    expect(r).toBe('aborted');
  });

  it('returns "timeout" at the safety cap', async () => {
    runningJob();
    const r = await parkForBackgroundWork(base({ capMs: 20 }));
    expect(r).toBe('timeout');
  });

  it('does NOT busy-return on an already-notified job while another runs (loop regression)', async () => {
    const a = runningJob(); // job-1
    const b = mgr.create({ sessionId: SID, jobId: 'job-2', groupId: 'g2', provider: 'p', model: 'm', agents: slots() });
    if ('error' in b) throw new Error('unexpected');
    mgr.settle(a, 'ra', usage, 'done');
    mgr.markDelivery(a, 'notified'); // job-1 terminal but already delivered.
    const pushed: string[] = [];
    // If the bug were present, park would return 'work' immediately with NO push
    // (job-1 already notified). With the fix it waits for the RUNNING job-2.
    setTimeout(() => mgr.settle(b, 'rb', usage, 'done'), 20);
    const r = await parkForBackgroundWork(base({ pushNotice: (t) => pushed.push(t) }));
    expect(r).toBe('work');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('job-2'); // delivered the newly-settled one
    expect(b.delivery).toBe('notified');
  });
});
