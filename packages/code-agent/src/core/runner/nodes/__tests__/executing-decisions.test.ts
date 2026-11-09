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
  it.each([
    new Error('Invalid schema for function \'ext_rea__capture_browser_scenario\': null is not of types "boolean", "object"'),
    Object.assign(new Error('Bad function parameters'), { code: 'invalid_function_parameters' }),
  ])('does not retry deterministic schema rejection as an unknown network failure', error => {
    expect(asProviderError(providerErrorEvent(error))).toMatchObject({ retryable: false, status: 0 });
  });

  it('retains the transport cause of native fetch terminated without exposing socket details', () => {
    const ev = asProviderError(providerErrorEvent(new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed https://secret.example/?token=private'), {
        code: 'UND_ERR_SOCKET',
      }),
    })));
    expect(ev).toMatchObject({ status: 0, retryable: true, code: 'UND_ERR_SOCKET' });
    expect(ev.message).toContain('UND_ERR_SOCKET');
    expect(ev.message).not.toContain('private');
  });

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

  it('tags a stream-idle TimeoutError for bounded transport recovery (status 0)', () => {
    const ev = asProviderError(providerErrorEvent(new TimeoutError(90_000, 'provider stream idle')));
    expect(ev.status).toBe(0);
    expect(ev.retryable).toBe(true);
    expect(ev.code).toBe('TIMEOUT');
  });

  it('tags a thinking-only stream timeout with code THINKING_TIMEOUT (own bucket)', () => {
    const err = new TimeoutError(240_000, 'provider thinking-only stream');
    (err as { reason?: string }).reason = 'thinking-only';
    const ev = asProviderError(providerErrorEvent(err));
    expect(ev.status).toBe(0); // still the status-less sentinel
    expect(ev.retryable).toBe(true);
    // Distinct from the generic 'TIMEOUT' so Recovering routes it to
    // provider-thinking-timeout (budget-doubling) instead of provider-unknown-retry.
    expect(ev.code).toBe('THINKING_TIMEOUT');
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
