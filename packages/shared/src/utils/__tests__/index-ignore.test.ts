import { describe, expect, it } from 'vitest';
import {
  globPrunesForIndexIgnore,
  normalizeIndexIgnoreFolderPattern,
  parseIndexIgnorePatterns,
  serializeIndexIgnorePatterns,
} from '../index-ignore.js';

describe('index ignore utilities', () => {
  it('normalizes UI folder entries without touching repo files', () => {
    expect(normalizeIndexIgnoreFolderPattern(' .\\generated\\client ')).toBe('generated/client/');
    expect(normalizeIndexIgnoreFolderPattern('docs/**')).toBe('docs/**');
    expect(normalizeIndexIgnoreFolderPattern('')).toBeNull();
  });

  it('parses JSON and plain text rules with dedupe', () => {
    expect(parseIndexIgnorePatterns('["dist/","dist/","tmp/"]')).toEqual(['dist/', 'tmp/']);
    expect(parseIndexIgnorePatterns('dist/\ntmp/, cache/')).toEqual(['dist/', 'tmp/', 'cache/']);
    expect(serializeIndexIgnorePatterns(['dist/', 'dist/', './tmp/'])).toBe('["dist/","tmp/"]');
  });

  it('derives safe directory prunes only from directory rules', () => {
    expect(globPrunesForIndexIgnore(['generated/', '*.log', '!dist/'])).toEqual([
      'generated/**',
      '**/generated/**',
    ]);
  });
});
