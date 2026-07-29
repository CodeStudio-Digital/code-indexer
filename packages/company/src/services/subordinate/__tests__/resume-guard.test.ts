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

function runId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

describe('resume-guard', () => {
  it('blocks a second acquire for the same agentRunId until released', () => {
    expect(tryAcquireResume(runId(1))).toBe(true);
    expect(tryAcquireResume(runId(1))).toBe(false);
    expect(isResumeInFlight(runId(1))).toBe(true);

    releaseResume(runId(1));
    expect(isResumeInFlight(runId(1))).toBe(false);
    expect(tryAcquireResume(runId(1))).toBe(true);
    releaseResume(runId(1));
  });

  it('tracks different agentRunIds independently', () => {
    expect(tryAcquireResume(runId(10))).toBe(true);
    expect(tryAcquireResume(runId(20))).toBe(true);
    expect(tryAcquireResume(runId(10))).toBe(false);
    expect(tryAcquireResume(runId(20))).toBe(false);

    releaseResume(runId(10));
    expect(tryAcquireResume(runId(10))).toBe(true);
    expect(isResumeInFlight(runId(20))).toBe(true);

    releaseResume(runId(10));
    releaseResume(runId(20));
  });

  it('release is a no-op when not held', () => {
    expect(isResumeInFlight(runId(99))).toBe(false);
    expect(() => releaseResume(runId(99))).not.toThrow();
    expect(isResumeInFlight(runId(99))).toBe(false);
  });

  it('serialises the resume pattern: a concurrent second call is rejected, body runs once', async () => {
    let bodyRuns = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });

    // Mirror resumeSubordinate: synchronous acquire, then an awaited body,
    // released in finally.
    const run = async (id: string): Promise<string> => {
      if (!tryAcquireResume(id)) throw new Error(`already resuming ${id}`);
      try {
        bodyRuns += 1;
        await gate; // simulate the long `await runCoder(...)` window
        return 'done';
      } finally {
        releaseResume(id);
      }
    };

    const first = run(runId(7)); // acquires, then parks on `gate`
    await expect(run(runId(7))).rejects.toThrow(/already resuming/); // loses synchronously

    release();
    await expect(first).resolves.toBe('done');
    expect(bodyRuns).toBe(1);
    expect(isResumeInFlight(runId(7))).toBe(false);
  });
});
