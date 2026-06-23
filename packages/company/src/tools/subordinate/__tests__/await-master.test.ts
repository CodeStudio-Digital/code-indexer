/**
 * Tests for the subordinate→master wait safety deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitMasterDecision,
  resolveMasterWaitMs,
  MASTER_WAIT_TIMEOUT,
  type MasterWaitRunner,
} from '../await-master.js';

function makeRunner(): MasterWaitRunner {
  let resolveFn: ((v: string) => void) | null = null;
  let pending = false;
  return {
    waitForUserInput(): Promise<string> {
      pending = true;
      return new Promise<string>((res) => {
        resolveFn = res;
      });
    },
    isWaitingForInput(): boolean {
      return pending;
    },
    provideUserInput(value: string): boolean {
      if (!pending || !resolveFn) return false;
      pending = false;
      const r = resolveFn;
      resolveFn = null;
      r(value);
      return true;
    },
  };
}

describe('resolveMasterWaitMs', () => {
  const original = process.env.MCP_SUBORDINATE_MASTER_WAIT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_SUBORDINATE_MASTER_WAIT_MS;
    else process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = original;
  });

  it('defaults to 30 minutes', () => {
    delete process.env.MCP_SUBORDINATE_MASTER_WAIT_MS;
    expect(resolveMasterWaitMs()).toBe(30 * 60 * 1000);
  });

  it('honors a positive override', () => {
    process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = '5000';
    expect(resolveMasterWaitMs()).toBe(5000);
  });

  it('falls back to default on garbage / non-positive', () => {
    process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = 'nope';
    expect(resolveMasterWaitMs()).toBe(30 * 60 * 1000);
    process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = '0';
    expect(resolveMasterWaitMs()).toBe(30 * 60 * 1000);
  });
});

describe('awaitMasterDecision', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves with the Master's answer when it arrives before the deadline", async () => {
    const runner = makeRunner();
    const p = awaitMasterDecision(runner);
    const answer = JSON.stringify({ answer: 'go ahead' });
    runner.provideUserInput(answer);
    await expect(p).resolves.toBe(answer);
  });

  it('unblocks with the interrupt sentinel when the Master never answers', async () => {
    process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = '5000';
    const runner = makeRunner();
    const p = awaitMasterDecision(runner);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(JSON.stringify(MASTER_WAIT_TIMEOUT));
    delete process.env.MCP_SUBORDINATE_MASTER_WAIT_MS;
  });

  it('does not fire the sentinel once the Master has already answered', async () => {
    process.env.MCP_SUBORDINATE_MASTER_WAIT_MS = '5000';
    const runner = makeRunner();
    const p = awaitMasterDecision(runner);
    runner.provideUserInput(JSON.stringify({ approved: true }));
    // Advancing past the deadline must NOT overwrite the real answer.
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe(JSON.stringify({ approved: true }));
    delete process.env.MCP_SUBORDINATE_MASTER_WAIT_MS;
  });
});
