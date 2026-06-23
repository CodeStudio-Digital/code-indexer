/** redactMeta keeps safe scalars and strips anything secret-ish or non-primitive,
 *  so the audit trail can never accidentally persist a password/token/hash. */
import { describe, it, expect } from 'vitest';
import { redactMeta } from '../infra/audit.js';

describe('redactMeta', () => {
  it('keeps plain scalars', () => {
    expect(redactMeta({ accountId: 'a1', status: 200, ok: true })).toEqual({ accountId: 'a1', status: 200, ok: true });
  });
  it('drops secret-ish keys', () => {
    const out = redactMeta({ password: 'p', token: 't', passwordHash: 'h', authorization: 'Bearer x', apiKey: 'k', secretThing: 's', accountId: 'a1' });
    expect(out).toEqual({ accountId: 'a1' });
  });
  it('drops nested objects / arrays (could hide a secret)', () => {
    expect(redactMeta({ nested: { token: 'x' }, list: [1, 2], accountId: 'a1' })).toEqual({ accountId: 'a1' });
  });
  it('truncates long strings to 256 chars', () => {
    const out = redactMeta({ note: 'x'.repeat(1000) });
    expect((out.note as string).length).toBe(256);
  });
  it('keeps null values', () => {
    expect(redactMeta({ accountId: null })).toEqual({ accountId: null });
  });
});
