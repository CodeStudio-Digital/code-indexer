/**
 * PR-C: unit-level retry harness behavior.
 * Integration test (execute_tasks invoking retry) lives in
 * `execute-tasks-retry-integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { dispatchWithRetry } from '../execute-tasks/task-retry.js';

const fastConfig = { maxRetries: 2, initialMs: 0, maxMs: 0, jitter: 0 };
const noSleep = () => Promise.resolve();

describe('dispatchWithRetry', () => {
  it('returns immediately on first attempt success', async () => {
    const attempt = vi.fn(async () => ({ result: 'ok', shouldStop: true }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error, succeeds on attempt 2', async () => {
    let i = 0;
    const attempt = vi.fn(async () => {
      i++;
      if (i === 1) {
        return { result: 'partial', shouldStop: false, errorMessage: 'ETIMEDOUT' };
      }
      return { result: 'ok', shouldStop: true };
    });
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(2);
    expect(out.result).toBe('ok');
  });

  it('bails on fatal error without retrying', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'HTTP 401 Unauthorized',
    }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent transient error', async () => {
    const attempt = vi.fn(async () => ({
      result: 'partial',
      shouldStop: false,
      errorMessage: 'ETIMEDOUT',
    }));
    const out = await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep });
    expect(out.attempts).toBe(3); // maxRetries=2 → 3 total attempts
  });

  it('fires onRetry between attempts with the delay + verdict', async () => {
    let i = 0;
    const attempt = vi.fn(async () => {
      i++;
      return i === 1
        ? { result: 'partial', shouldStop: false, errorMessage: 'rate limit' }
        : { result: 'ok', shouldStop: true };
    });
    const onRetry = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 0,
        nextAttempt: 1,
        verdict: 'transient',
        errorMessage: 'rate limit',
      }),
    );
  });

  it('fires onFinish with the final outcome (fatal)', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'invalid_request',
    }));
    const onFinish = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, verdict: 'fatal' }),
    );
  });

  it('fires onFinish with verdict=null on clean success', async () => {
    const attempt = vi.fn(async () => ({ result: 'ok', shouldStop: true }));
    const onFinish = vi.fn();
    await dispatchWithRetry(attempt, { config: fastConfig, sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, verdict: null }),
    );
  });

  it('maxRetries=0 means a single attempt only', async () => {
    const attempt = vi.fn(async () => ({
      result: 'failed',
      shouldStop: false,
      errorMessage: 'ETIMEDOUT',
    }));
    const out = await dispatchWithRetry(attempt, {
      config: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
      sleep: noSleep,
    });
    expect(out.attempts).toBe(1);
  });
});
