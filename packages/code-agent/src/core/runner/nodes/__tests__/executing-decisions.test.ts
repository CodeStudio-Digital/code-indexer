/**
 * Unit tests for `providerErrorEvent` — the function that turns a thrown
 * provider error into a `ProviderError` BT event.
 *
 * Contract:
 *   1. Extracts a numeric HTTP status from `APIError`-shaped errors and keeps
 *      the legacy retryable rule (>=500 || 429 || 401).
 *   2. Carries the human message + provider code through to the event.
 *   3. Status-less errors get sentinel status 0 and are retryable BY DEFAULT…
 *   4. …unless the message matches a fatal signature, then non-retryable.
 *   5. Always logs one `[coder] ProviderError …` line (no debug flag needed).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { providerErrorEvent } from '../executing-decisions.js';
import { TimeoutError } from '../executing-abort.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function asProviderError(e: ReturnType<typeof providerErrorEvent>) {
  if (e.kind !== 'ProviderError') throw new Error(`expected ProviderError, got ${e.kind}`);
  return e;
}

describe('providerErrorEvent', () => {
  it('extracts status + message + code from an APIError-shaped error', () => {
    const ev = asProviderError(
      providerErrorEvent(
        Object.assign(new Error('Rate limited'), {
          status: 429,
          code: 'rate_limit_exceeded',
        }),
      ),
    );
    expect(ev.status).toBe(429);
    expect(ev.retryable).toBe(true);
    expect(ev.message).toBe('Rate limited');
    expect(ev.code).toBe('rate_limit_exceeded');
  });

  it('reads the OpenAI-compat error body (.error.message / .error.code)', () => {
    const ev = asProviderError(
      providerErrorEvent({
        status: 404,
        error: { message: 'The model `glm-5.2` does not exist', code: 'model_not_found' },
      }),
    );
    expect(ev.status).toBe(404);
    expect(ev.message).toBe('The model `glm-5.2` does not exist');
    expect(ev.code).toBe('model_not_found');
    // 404 is below the retryable threshold → non-retryable.
    expect(ev.retryable).toBe(false);
  });

  it('keeps the legacy retryable rule for 5xx / 401', () => {
    expect(asProviderError(providerErrorEvent({ status: 503 })).retryable).toBe(true);
    expect(asProviderError(providerErrorEvent({ status: 401 })).retryable).toBe(true);
    expect(asProviderError(providerErrorEvent({ status: 400 })).retryable).toBe(false);
  });

  it('uses sentinel status 0 and stays retryable for a status-less error', () => {
    const ev = asProviderError(providerErrorEvent(new Error('socket hang up')));
    expect(ev.status).toBe(0);
    expect(ev.retryable).toBe(true);
    expect(ev.message).toBe('socket hang up');
  });

  it('marks a status-less FATAL message as non-retryable', () => {
    const ev = asProviderError(
      providerErrorEvent(new Error('stream error: model not found for this endpoint')),
    );
    expect(ev.status).toBe(0);
    expect(ev.retryable).toBe(false);
    expect(ev.message).toMatch(/model not found/);
  });

  it('routes a stream-idle TimeoutError to the low-cap unknown bucket (status 0)', () => {
    const ev = asProviderError(providerErrorEvent(new TimeoutError(90_000, 'provider stream idle')));
    expect(ev.status).toBe(0); // sentinel → provider-unknown-retry (cap 4), not transient-30
    expect(ev.retryable).toBe(true);
    expect(ev.code).toBe('TIMEOUT');
  });

  it('logs one [coder] ProviderError line unconditionally', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    providerErrorEvent(Object.assign(new Error('boom'), { status: 500 }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[coder] ProviderError');
    expect(warn.mock.calls[0]?.[0]).toContain('status=500');
    expect(warn.mock.calls[0]?.[0]).toContain('boom');
  });
});
