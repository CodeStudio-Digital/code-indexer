/**
 * PR-2 (R5) — exp+jitter backoff for transient retries.
 *
 * Verifies that backoffDelayMs grows exponentially up to the cap and that
 * jitter stays within the symmetric range. Mirrors kimi-cli's
 * `wait_exponential_jitter(initial=0.3, max=5, jitter=0.5)`.
 */
import { describe, it, expect } from 'vitest';
import { backoffDelayMs } from '../core/coder/core/runner.js';

describe('backoffDelayMs', () => {
  it('returns ~initial on attempt 1 with no jitter', () => {
    expect(backoffDelayMs(1, { initialMs: 300, maxMs: 5000, jitter: 0, rng: () => 0.5 })).toBe(300);
  });

  it('doubles each attempt up to the cap (no jitter)', () => {
    const opts = { initialMs: 100, maxMs: 5000, jitter: 0, rng: () => 0.5 };
    expect(backoffDelayMs(1, opts)).toBe(100);
    expect(backoffDelayMs(2, opts)).toBe(200);
    expect(backoffDelayMs(3, opts)).toBe(400);
    expect(backoffDelayMs(4, opts)).toBe(800);
    expect(backoffDelayMs(5, opts)).toBe(1600);
    expect(backoffDelayMs(6, opts)).toBe(3200);
  });

  it('caps at maxMs even for high attempt numbers', () => {
    const opts = { initialMs: 300, maxMs: 5000, jitter: 0, rng: () => 0.5 };
    expect(backoffDelayMs(20, opts)).toBe(5000);
    expect(backoffDelayMs(50, opts)).toBe(5000);
  });

  it('applies symmetric jitter — rng=0 yields base*(1-j), rng=1 yields base*(1+j)', () => {
    const opts = { initialMs: 1000, maxMs: 10_000, jitter: 0.5 };
    const lo = backoffDelayMs(1, { ...opts, rng: () => 0 });
    const hi = backoffDelayMs(1, { ...opts, rng: () => 1 });
    expect(lo).toBe(500); // 1000 + 1000 * 0.5 * (-1)
    expect(hi).toBe(1500); // 1000 + 1000 * 0.5 * (+1)
  });

  it('never returns a negative delay even when jitter would push it below zero', () => {
    // Pathological: jitter > 1 plus rng=0 would compute a negative value.
    const d = backoffDelayMs(1, { initialMs: 100, maxMs: 1000, jitter: 2, rng: () => 0 });
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it('clamps fractional or zero attempt numbers to attempt=1', () => {
    const opts = { initialMs: 200, maxMs: 5000, jitter: 0, rng: () => 0.5 };
    expect(backoffDelayMs(0, opts)).toBe(200);
    expect(backoffDelayMs(0.5, opts)).toBe(200);
    expect(backoffDelayMs(-3, opts)).toBe(200);
  });
});
