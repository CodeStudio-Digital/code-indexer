/**
 * Coverage for `normalizeSeedUrl` — the helper that bails the user out
 * when they paste a bare host instead of a full URL. Real-world incident:
 * `docs.unity3d.com/...` (no scheme) tripped the crawler's silent skip
 * and produced a 3ms "DONE 0 pages" with no clue what was wrong.
 */
import { describe, it, expect } from 'vitest';
import { normalizeSeedUrl } from '../index-doc-use-case.js';

describe('normalizeSeedUrl', () => {
  it('passes through fully-qualified https URLs unchanged (modulo URL normalization)', () => {
    expect(normalizeSeedUrl('https://example.com/foo'))
      .toBe('https://example.com/foo');
  });

  it('preserves http://', () => {
    expect(normalizeSeedUrl('http://example.com')).toBe('http://example.com/');
  });

  it('auto-prepends https:// for bare hosts', () => {
    expect(normalizeSeedUrl('docs.unity3d.com/6000.3/Documentation/Manual/UnityManual.html'))
      .toBe('https://docs.unity3d.com/6000.3/Documentation/Manual/UnityManual.html');
  });

  it('auto-prepends https:// for bare host without path', () => {
    expect(normalizeSeedUrl('react.dev')).toBe('https://react.dev/');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeSeedUrl('   https://example.com   '))
      .toBe('https://example.com/');
  });

  it('returns null for empty input', () => {
    expect(normalizeSeedUrl('')).toBeNull();
    expect(normalizeSeedUrl('   ')).toBeNull();
  });

  it('returns null for leading-slash paths (no host to assume)', () => {
    expect(normalizeSeedUrl('/docs/foo')).toBeNull();
  });

  it('returns null for inputs without a TLD', () => {
    expect(normalizeSeedUrl('localhost')).toBeNull();
    expect(normalizeSeedUrl('docs')).toBeNull();
  });

  it('preserves the query string and path', () => {
    expect(normalizeSeedUrl('example.com/foo?bar=baz'))
      .toBe('https://example.com/foo?bar=baz');
  });
});
