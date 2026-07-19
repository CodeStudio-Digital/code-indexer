import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOC_SEARCH_TIMEOUT_MS,
  resolveDocSearchTimeoutMs,
} from '../doc-search-timeout.js';

describe('resolveDocSearchTimeoutMs', () => {
  it('defaults documentation search RPCs to five minutes', () => {
    expect(resolveDocSearchTimeoutMs('')).toBe(5 * 60_000);
    expect(DEFAULT_DOC_SEARCH_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('accepts a configured timeout within the supported range', () => {
    expect(resolveDocSearchTimeoutMs('600000')).toBe(10 * 60_000);
  });

  it.each(['not-a-number', '59999', '1800001'])('rejects an unsafe timeout: %s', (raw) => {
    expect(resolveDocSearchTimeoutMs(raw)).toBe(DEFAULT_DOC_SEARCH_TIMEOUT_MS);
  });
});
