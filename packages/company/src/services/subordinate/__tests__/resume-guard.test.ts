/**
 * Tests for the per-agentRunId resume in-flight guard. The guard makes
 * concurrent resume/reactivate on the same agent_run impossible, which is what
 * prevents two `runCoder` runs from interleaving on one coder session.
 */
import { describe, expect, it } from 'vitest';
import {
  tryAcquireResume,
  releaseResume,
  isResumeInFlight,
} from '@mcp/company/services/subordinate/resume-guard.js';

describe('resume-guard', () => {
  it('blocks a second acquire for the same agentRunId until released', () => {
    expect(tryAcquireResume(1)).toBe(true);
    expect(tryAcquireResume(1)).toBe(false);
    expect(isResumeInFlight(1)).toBe(true);

    releaseResume(1);
    expect(isResumeInFlight(1)).toBe(false);
    expect(tryAcquireResume(1)).toBe(true);
    releaseResume(1);
  });

  it('tracks different agentRunIds independently', () => {
    expect(tryAcquireResume(10)).toBe(true);
    expect(tryAcquireResume(20)).toBe(true);
    expect(tryAcquireResume(10)).toBe(false);
    expect(tryAcquireResume(20)).toBe(false);

    releaseResume(10);
    expect(tryAcquireResume(10)).toBe(true);
    expect(isResumeInFlight(20)).toBe(true);

    releaseResume(10);
    releaseResume(20);
  });

  it('release is a no-op when not held', () => {
    expect(isResumeInFlight(99)).toBe(false);
    expect(() => releaseResume(99)).not.toThrow();
    expect(isResumeInFlight(99)).toBe(false);
  });

  it('serialises the resume pattern: a concurrent second call is rejected, body runs once', async () => {
    let bodyRuns = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    // Mirror resumeSubordinate: synchronous acquire, then an awaited body,
    // released in finally.
    const run = async (id: number): Promise<string> => {
      if (!tryAcquireResume(id)) throw new Error(`already resuming ${id}`);
      try {
        bodyRuns += 1;
        await gate; // simulate the long `await runCoder(...)` window
        return 'done';
      } finally {
        releaseResume(id);
      }
    };

    const first = run(7); // acquires, then parks on `gate`
    await expect(run(7)).rejects.toThrow(/already resuming 7/); // loses synchronously

    release();
    await expect(first).resolves.toBe('done');
    expect(bodyRuns).toBe(1);
    expect(isResumeInFlight(7)).toBe(false);
  });
});
