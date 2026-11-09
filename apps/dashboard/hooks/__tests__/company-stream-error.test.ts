import { describe, expect, it } from 'vitest';
import { companyStreamError } from '../company-stream-error.js';

describe('Company error details', () => {
  it.each([
    [{ error: 'Master start failed: session is leased' }, 'Master start failed: session is leased'],
    [{ message: 'worker exited', reason: 'worker_crashed' }, 'worker exited'],
    [{ error: { message: 'authentication expired' } }, 'authentication expired'],
    [{ reason: 'company-resume-failed' }, 'company-resume-failed'],
    [{ code: 'OUTCOME_UNKNOWN' }, 'OUTCOME_UNKNOWN'],
    [Object.assign(new Error('HTTP 500'), { httpBody: { error: 'Failed to start Master' } }), 'Failed to start Master'],
    [null, 'Fallback'],
    [{ error: {} }, 'Fallback'],
  ])('renders supported server payloads %#', (payload, expected) => {
    expect(companyStreamError(payload, 'Fallback')).toBe(expected);
  });
  it('bounds malformed cyclic error data', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.error = cyclic;
    expect(companyStreamError(cyclic, 'Fallback')).toBe('Fallback');
  });
});
