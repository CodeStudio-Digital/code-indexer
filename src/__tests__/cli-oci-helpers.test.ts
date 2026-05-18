import { describe, it, expect } from 'vitest';
import {
  parseMemBytes,
  parsePercent,
  sanitizeContainerName,
} from '@mcp/services/sandbox/drivers/cli-oci/helpers.js';

describe('sanitizeContainerName', () => {
  it('prefixes with mcp-sbx- and keeps safe characters', () => {
    expect(sanitizeContainerName('42')).toBe('mcp-sbx-42');
    expect(sanitizeContainerName('abc_123.test-x')).toBe('mcp-sbx-abc_123.test-x');
  });

  it('replaces forbidden characters with dash', () => {
    expect(sanitizeContainerName('a/b c:d')).toBe('mcp-sbx-a-b-c-d');
    expect(sanitizeContainerName('foo:bar')).toBe('mcp-sbx-foo-bar');
  });

  it('truncates to 48 chars of the session id portion', () => {
    expect(sanitizeContainerName('x'.repeat(100))).toBe('mcp-sbx-' + 'x'.repeat(48));
  });
});

describe('parsePercent', () => {
  it('parses a clean percentage string', () => {
    expect(parsePercent('12.3%')).toBe(12.3);
    expect(parsePercent('5%')).toBe(5);
  });

  it('parses an unsuffixed numeric string', () => {
    expect(parsePercent('42')).toBe(42);
  });

  it('returns null for empty / undefined / non-string', () => {
    expect(parsePercent(undefined)).toBeNull();
    expect(parsePercent('')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(parsePercent('not a number')).toBeNull();
    expect(parsePercent('   ')).toBeNull();
  });

  it('extracts the first numeric token even with extra noise', () => {
    expect(parsePercent('cpu: 8.5%')).toBe(8.5);
  });
});

describe('parseMemBytes', () => {
  it('parses IEC binary suffixes (used / limit form)', () => {
    expect(parseMemBytes('245.8MiB / 1GiB')).toBeCloseTo(245.8 * 1024 ** 2);
    expect(parseMemBytes('1GiB / 4GiB')).toBe(1024 ** 3);
  });

  it('parses SI decimal suffixes', () => {
    expect(parseMemBytes('245.8MB / 1GB')).toBeCloseTo(245.8 * 1_000_000);
    expect(parseMemBytes('1GB / 4GB')).toBe(1_000_000_000);
  });

  it('parses raw byte counts', () => {
    expect(parseMemBytes('245800000')).toBe(245_800_000);
  });

  it('returns null for null/undefined', () => {
    expect(parseMemBytes(undefined)).toBeNull();
  });

  it('handles unsuffixed input as bytes', () => {
    expect(parseMemBytes('100B')).toBe(100);
  });

  it('case-insensitive on the suffix', () => {
    expect(parseMemBytes('1gib')).toBe(1024 ** 3);
    expect(parseMemBytes('1KIB')).toBe(1024);
  });

  it('falls back to numeric parse when regex doesn`t match', () => {
    expect(parseMemBytes('abc')).toBeNull();
    expect(parseMemBytes('  42  ')).toBe(42);
  });
});
