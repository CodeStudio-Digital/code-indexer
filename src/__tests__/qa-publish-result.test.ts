import { describe, it, expect } from 'vitest';
import { coercePayload } from '../core/coder/tools/company/qa/qa-publish-result.js';

describe('coercePayload (qa_publish_result)', () => {
  it('coerces a minimal valid payload', () => {
    const out = coercePayload(
      { suite: 'login', passed: 3, failed: 0 },
      'qa-engineer',
      42,
    );
    expect(out).toEqual({
      agent_run_id: 42,
      agent_role: 'qa-engineer',
      suite: 'login',
      passed: 3,
      failed: 0,
      skipped: 0,
      duration_ms: undefined,
      trace_urls: undefined,
      failing_tests: undefined,
    });
  });

  it('includes optional fields when present', () => {
    const out = coercePayload(
      {
        suite: 'login',
        passed: 2,
        failed: 1,
        skipped: 1,
        duration_ms: 12345,
        trace_urls: ['traces/login-1.zip'],
        failing_tests: [{ name: 'wrong password', error: 'expected toast' }],
      },
      'qa',
      99,
    );
    expect(out.skipped).toBe(1);
    expect(out.duration_ms).toBe(12345);
    expect(out.trace_urls).toEqual(['traces/login-1.zip']);
    expect(out.failing_tests).toEqual([{ name: 'wrong password', error: 'expected toast' }]);
  });

  it('rejects non-string suite', () => {
    expect(() =>
      coercePayload({ suite: 123, passed: 0, failed: 0 } as Record<string, unknown>, 'r', 1),
    ).toThrow(/suite must be a non-empty string/);
  });

  it('rejects empty suite', () => {
    expect(() =>
      coercePayload({ suite: '', passed: 0, failed: 0 }, 'r', 1),
    ).toThrow(/suite must be a non-empty string/);
  });

  it('rejects negative counts', () => {
    expect(() =>
      coercePayload({ suite: 's', passed: -1, failed: 0 }, 'r', 1),
    ).toThrow(/passed must be a non-negative integer/);
  });

  it('rejects fractional counts', () => {
    expect(() =>
      coercePayload({ suite: 's', passed: 1.5, failed: 0 }, 'r', 1),
    ).toThrow(/passed must be a non-negative integer/);
  });

  it('rejects non-array trace_urls', () => {
    expect(() =>
      coercePayload(
        { suite: 's', passed: 0, failed: 0, trace_urls: 'not-an-array' },
        'r',
        1,
      ),
    ).toThrow(/trace_urls must be an array/);
  });

  it('rejects malformed failing_tests entries', () => {
    expect(() =>
      coercePayload(
        { suite: 's', passed: 0, failed: 1, failing_tests: [{ name: 'x' }] },
        'r',
        1,
      ),
    ).toThrow(/failing_tests\[0\].error must be a non-empty string/);
  });

  it('preserves null agent_run_id', () => {
    const out = coercePayload({ suite: 's', passed: 0, failed: 0 }, 'r', null);
    expect(out.agent_run_id).toBeNull();
  });
});
