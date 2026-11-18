import { describe, expect, it } from 'vitest';
import { nextSemanticRetry } from '../semantic-retry-policy.js';

describe('background semantic retry policy', () => {
  it('honors rate-limit cooldown and opens the circuit after eight failures', () => {
    expect(nextSemanticRetry(new Error('429 Retry-After: 120'), 0, 1000))
      .toEqual({ attempt: 1, not_before_ms: 121000, blocked: false });
    expect(nextSemanticRetry(new Error('memory embedding failed'), 7, 1000).blocked).toBe(true);
  });
  it('does not repeatedly try a missing native runtime or invalid credentials', () => {
    expect(nextSemanticRetry(new Error('Não foi possível encontrar o módulo especificado.')).blocked).toBe(true);
    expect(nextSemanticRetry(new Error('HTTP 401 unauthorized')).blocked).toBe(true);
  });
  it('keeps temporary SQLite contention retryable with a bounded delay', () => {
    expect(nextSemanticRetry(new Error('SQLITE_BUSY'), 20, 1000))
      .toEqual({ attempt: 21, not_before_ms: 6000, blocked: false });
  });
});
it('keeps transient quota failures retryable even after the old eight-attempt cap', () => {
  const retry = nextSemanticRetry(new Error('429 Rate limit exceeded Retry-After: 120'), 25, 1000);
  expect(retry).toMatchObject({ attempt: 26, blocked: false });
  expect(retry.not_before_ms).toBe(901000);
});
