import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS,
  parseQueryTimeoutMs,
} from '../index.js';

describe('parseQueryTimeoutMs', () => {
  it('keeps omitted timeouts backward compatible', () => {
    expect(parseQueryTimeoutMs(undefined)).toBeUndefined();
  });

  it('accepts the supported millisecond range', () => {
    expect(parseQueryTimeoutMs(MIN_QUERY_TIMEOUT_MS)).toBe(MIN_QUERY_TIMEOUT_MS);
    expect(parseQueryTimeoutMs(MAX_QUERY_TIMEOUT_MS)).toBe(MAX_QUERY_TIMEOUT_MS);
  });

  it.each([0, 999, 3_600_001, 1.5, '60000'])('rejects unsafe timeouts: %s', (value) => {
    expect(() => parseQueryTimeoutMs(value)).toThrow(/query timeout must be an integer/i);
  });
});
