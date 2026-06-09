/**
 * Tests for runAgentWaitLoop — the shared wait mechanism behind
 * wait_for_subordinates (fleet) and wait_agents (targets).
 *
 * Core regression: the safety poll must re-check the done-condition and
 * return `all_done` even when NO attention signal arrives — the deadlock
 * where the last agent's `finished` signal was lost and the master slept to
 * the 30-min deadline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runAgentWaitLoop,
  SAFETY_POLL_MS,
  type WaitLoopOrchestrator,
} from '../agent-wait-loop.js';
import type { AttentionEvent, AttentionListener } from '../../services/MasterAttention.js';

function makeOrch(over: Partial<WaitLoopOrchestrator>): {
  orch: WaitLoopOrchestrator;
  fire: (ev: AttentionEvent) => void;
} {
  const listeners = new Set<AttentionListener>();
  const orch: WaitLoopOrchestrator = {
    hasRunningSubordinates: over.hasRunningSubordinates ?? (() => false),
    listSubordinates: over.listSubordinates ?? (() => []),
    masterHasPendingMessages: over.masterHasPendingMessages ?? (() => false),
    onSubordinateAttention:
      over.onSubordinateAttention ??
      ((l: AttentionListener) => {
        listeners.add(l);
        return () => listeners.delete(l);
      }),
  };
  const fire = (ev: AttentionEvent) => {
    for (const l of [...listeners]) l(ev);
  };
  return { orch, fire };
}

afterEach(() => vi.useRealTimers());

describe('runAgentWaitLoop — safety poll (the deadlock fix)', () => {
  it('fleet mode: returns all_done via the poll even with NO attention signal', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { orch } = makeOrch({
      hasRunningSubordinates: () => {
        calls++;
        return calls <= 1; // running once, then the last one "finished" silently
      },
    });
    const p = runAgentWaitLoop(orch, {
      targetIds: null,
      isMaster: true,
      deadlineMs: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS);
    await expect(p).resolves.toEqual({ kind: 'all_done' });
  });

  it('targets mode: returns all_done when the target goes terminal with no signal', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { orch } = makeOrch({
      listSubordinates: () => {
        calls++;
        return [{ agentRunId: 7, status: calls <= 1 ? 'running' : 'completed' }];
      },
    });
    const p = runAgentWaitLoop(orch, {
      targetIds: new Set([7]),
      isMaster: true,
      deadlineMs: Date.now() + 60_000,
    });
    await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS);
    await expect(p).resolves.toEqual({ kind: 'all_done' });
  });

  it('returns deadline when the wait window elapses while still running', async () => {
    vi.useFakeTimers();
    const { orch } = makeOrch({ hasRunningSubordinates: () => true });
    const p = runAgentWaitLoop(orch, {
      targetIds: null,
      isMaster: true,
      deadlineMs: Date.now() + 1_000, // shorter than one poll
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toEqual({ kind: 'deadline' });
  });
});

describe('runAgentWaitLoop — event-driven returns (master)', () => {
  it('returns attention when a target posts a plan', async () => {
    const { orch, fire } = makeOrch({
      listSubordinates: () => [{ agentRunId: 7, status: 'running' }],
    });
    const p = runAgentWaitLoop(orch, {
      targetIds: new Set([7]),
      isMaster: true,
      deadlineMs: Date.now() + 60_000,
    });
    await Promise.resolve(); // let the loop subscribe
    fire({ kind: 'plan', agentRunId: 7, role: 'qa' });
    await expect(p).resolves.toEqual({
      kind: 'attention',
      event: { kind: 'plan', agentRunId: 7, role: 'qa' },
    });
  });

  it('returns message on a notify wake', async () => {
    const { orch, fire } = makeOrch({ hasRunningSubordinates: () => true });
    const p = runAgentWaitLoop(orch, {
      targetIds: null,
      isMaster: true,
      deadlineMs: Date.now() + 60_000,
    });
    await Promise.resolve();
    fire({ kind: 'notify', agentRunId: 0, role: 'system' });
    await expect(p).resolves.toEqual({ kind: 'message', via: 'notify' });
  });

  it('level-triggers pending_messages before sleeping', async () => {
    const { orch } = makeOrch({
      hasRunningSubordinates: () => true,
      masterHasPendingMessages: () => true,
    });
    await expect(
      runAgentWaitLoop(orch, {
        targetIds: null,
        isMaster: true,
        deadlineMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ kind: 'pending_messages' });
  });
});

describe('runAgentWaitLoop — subordinate gating (isMaster=false)', () => {
  it('ignores a target question (only the master resolves prompts) and keeps waiting', async () => {
    vi.useFakeTimers();
    let terminal = false;
    const { orch, fire } = makeOrch({
      listSubordinates: () => [{ agentRunId: 7, status: terminal ? 'completed' : 'running' }],
    });
    const p = runAgentWaitLoop(orch, {
      targetIds: new Set([7]),
      isMaster: false,
      deadlineMs: Date.now() + 60_000,
    });
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    fire({ kind: 'question', agentRunId: 7, role: 'qa' }); // subordinate must NOT resolve on this
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // still waiting
    terminal = true;
    await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS);
    await expect(p).resolves.toEqual({ kind: 'all_done' });
  });
});
