import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY_TIMEOUT_SECONDS,
  MAX_QUERY_TIMEOUT_SECONDS,
  MIN_QUERY_TIMEOUT_SECONDS,
  queryTimeoutMsFromSeconds,
} from '../query-timeout.js';

describe('queryTimeoutMsFromSeconds', () => {
  it('uses a one-minute default suitable for SQL Server reports', () => {
    expect(queryTimeoutMsFromSeconds(String(DEFAULT_QUERY_TIMEOUT_SECONDS))).toBe(60_000);
  });

  it('accepts the inclusive user-selectable range', () => {
    expect(queryTimeoutMsFromSeconds(String(MIN_QUERY_TIMEOUT_SECONDS))).toBe(1_000);
    expect(queryTimeoutMsFromSeconds(String(MAX_QUERY_TIMEOUT_SECONDS))).toBe(3_600_000);
  });

  it.each(['', '0', '1.5', '-1', '3601', 'Infinity'])('rejects invalid input: %s', (value) => {
    expect(queryTimeoutMsFromSeconds(value)).toBeNull();
  });
});
