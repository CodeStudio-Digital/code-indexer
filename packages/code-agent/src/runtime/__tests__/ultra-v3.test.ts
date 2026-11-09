import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUltraPreset } from '../../sessions/ultra-policy.js';
import { runReadyWorkflow } from '../../tools/workflow/workflow-readiness.js';
import type { WorkflowRecord, WorkflowStepState } from '../../tools/workflow/workflow-types.js';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import { ChatScheduler } from '../chat-scheduler.js';
import { nextCron, wallTime } from '../chat-calendar.js';

describe('Ultra v3 invariants', () => {
  it('preserves effort and publishes the effective cap', () => {
    const policy = resolveUltraPreset({ enabled: true, effort: 'high', maxParallel: 1 });
    expect(policy.effective.reasoning.effort).toBe('high');
    expect(policy.effective.parallelism.maxAgents).toBe(1);
    expect(resolveUltraPreset({ enabled: true, effort: 'xhigh', supportedEfforts: ['high'] }).effective.reasoning.mode).toBe('auto');
  });
  it('starts a successor without waiting for an unrelated slow sibling; rejects partial by default', async () => {
    const steps = ['a', 'b', 'va', 'vb'].map(id => ({ id, title: id, prompt: id, profileId: 'explore', wave: 1,
      status: 'pending', dependsOn: id === 'va' ? ['a'] : id === 'vb' ? ['b'] : [] } as WorkflowStepState));
    const record = { steps } as WorkflowRecord;
    let releaseB!: () => void; const blocked = new Promise<void>(r => { releaseB = r; });
    const started: string[] = [];
    await runReadyWorkflow(record, 2, async step => {
      started.push(step.id);
      if (step.id === 'b') await blocked;
      if (step.id === 'va') releaseB();
      step.status = step.id === 'b' ? 'partial' : 'completed';
    });
    expect(started).toEqual(['a', 'b', 'va']);
    expect(steps[3].status).toBe('pending');
  });
  it('CAS admits only the last available budget slot and survives a new instance', async () => {
    const path = await mkdtemp(join(tmpdir(), 'ultra-budget-'));
    try {
      const mailbox = new ChatCollaborationStore(path); await mailbox.init();
      const limits = { maxParallel: 1, maxStarts: 1 };
      const a = new CollaborationBudget(mailbox.files, 'root', limits), b = new CollaborationBudget(mailbox.files, 'root', limits);
      const outcomes = await Promise.allSettled([a.reserve('a', 'one'), b.reserve('b', 'two')]);
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const fresh = new CollaborationBudget(mailbox.files, 'root', limits);
      expect(Object.keys((await fresh.state()).reservations)).toHaveLength(1);
      await expect(fresh.reserve('c', 'three')).rejects.toThrow('budget_exhausted');
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('journals all completions, distinguishes abort, and fences pre-stop messages', async () => {
    const path = await mkdtemp(join(tmpdir(), 'ultra-events-'));
    try {
      const store = new ChatCollaborationStore(path); await store.init();
      await store.registerRoot('a', 'A'); await store.registerRoot('b', 'B'); await store.linkSessions('a', 'b', true);
      const message = await store.send({ from: 'chat:a', to: 'chat:b', kind: 'question', body: 'Result?', idempotencyKey: 'q' });
      const abort = new AbortController(); abort.abort();
      expect((await store.waitResult('chat:a', message.id, 60000, abort.signal)).reason).toBe('aborted');
      expect((await store.get(message.id)).status).toBe('queued');
      await store.recordCompletion({ sessionId: 'a', runId: '1', at: 1, reason: 'completed' });
      await store.recordCompletion({ sessionId: 'a', runId: '2', at: 2, reason: 'error' });
      expect((await store.completions('a')).map(row => row.runId)).toEqual(['1', '2']);
      await store.stopSession('b'); await store.registerRoot('b', 'B');
      expect(await store.currentGeneration(message)).toBe(false);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('fires once after restart and never executes an unauthorized timer', async () => {
    const path = await mkdtemp(join(tmpdir(), 'ultra-timer-')); let now = Date.parse('2026-01-01T12:00:00Z');
    try {
      const store = new ChatCollaborationStore(path); await store.init(); await store.registerRoot('a', 'A');
      const input = { kind: 'once' as const, at: now + 1000, timezone: 'UTC', action: 'notify' as const,
        prompt: 'Reminder', misfire: 'fire_once' as const, overlap: 'skip' as const, maxRuns: 1 };
      await new ChatScheduler(store, () => now).create('a', input, 'allowed', true);
      await new ChatScheduler(store, () => now).create('a', input, 'draft', false);
      now += 600000;
      const scheduler = new ChatScheduler(store, () => now);
      await Promise.all([scheduler.tick(), new ChatScheduler(store, () => now).tick()]);
      await scheduler.tick();
      expect(await scheduler.records.list('occurrences')).toHaveLength(1);
      expect(await store.pending()).toHaveLength(0);
    } finally { await rm(path, { recursive: true, force: true }); }
  });
  it('handles DST gaps and suppresses repeated wall slots', () => {
    const first = nextCron('30 1 * * *', 'America/New_York', Date.parse('2026-11-01T04:00:00Z'));
    const second = nextCron('30 1 * * *', 'America/New_York', first, wallTime(first, 'America/New_York'));
    expect(first).toBe(Date.parse('2026-11-01T05:30:00Z'));
    expect(second).toBe(Date.parse('2026-11-02T06:30:00Z'));
    expect(nextCron('30 2 * * *', 'America/New_York', Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-09T06:30:00Z'));
  });
});
