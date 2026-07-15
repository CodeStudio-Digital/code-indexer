import { describe, expect, it } from 'vitest';
import type { PhpExtension } from '@mcp/api-bus';
import { filterPhpExtensions } from '../php-extension-search.js';

const extensions: PhpExtension[] = [
  { name: 'apcu', builtin: true, enabled: true, loaded: true },
  { name: 'curl', builtin: true, enabled: true, loaded: true },
  { name: 'pdo_mysql', builtin: true, enabled: false, loaded: false },
];

describe('filterPhpExtensions', () => {
  it('returns every extension for an empty query', () => {
    expect(filterPhpExtensions(extensions, '  ')).toEqual(extensions);
  });

  it('matches partial names case-insensitively', () => {
    expect(filterPhpExtensions(extensions, 'APC')).toEqual([extensions[0]]);
    expect(filterPhpExtensions(extensions, 'pdo_')).toEqual([extensions[2]]);
  });

  it('returns an empty list when no extension matches', () => {
    expect(filterPhpExtensions(extensions, 'redis')).toEqual([]);
  });
});
