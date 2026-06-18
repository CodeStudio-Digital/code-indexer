import { describe, it, expect } from 'vitest';
import { normalizeKvList, parseMap, buildUrlFromRows, buildUrl } from '../request-builder.js';

describe('normalizeKvList', () => {
  it('reads the legacy object form', () => {
    expect(normalizeKvList('{"A":"1","B":"2"}')).toEqual([
      { key: 'A', value: '1', enabled: true },
      { key: 'B', value: '2', enabled: true },
    ]);
  });

  it('reads the new array form, defaulting enabled on', () => {
    const rows = normalizeKvList('[{"key":"A","value":"1"},{"key":"B","value":"2","enabled":false}]');
    expect(rows[0]).toEqual({ key: 'A', value: '1', enabled: true });
    expect(rows[1].enabled).toBe(false);
  });

  it('returns [] for empty/garbage/null', () => {
    expect(normalizeKvList('')).toEqual([]);
    expect(normalizeKvList('{}')).toEqual([]);
    expect(normalizeKvList('not json')).toEqual([]);
    expect(normalizeKvList(null)).toEqual([]);
  });
});

describe('parseMap', () => {
  it('collapses enabled rows to a map (last-write-wins)', () => {
    expect(parseMap('[{"key":"A","value":"1"},{"key":"A","value":"2"}]')).toEqual({ A: '2' });
  });
  it('skips disabled rows', () => {
    expect(parseMap('[{"key":"A","value":"1","enabled":false},{"key":"B","value":"2"}]')).toEqual({ B: '2' });
  });
  it('still parses the legacy object form', () => {
    expect(parseMap('{"X":"y"}')).toEqual({ X: 'y' });
  });
});

describe('buildUrlFromRows', () => {
  const vars = { host: 'example.com', id: '42' };
  it('preserves duplicate query keys and resolves templates', () => {
    const url = buildUrlFromRows('https://{{host}}', '/items', [
      { key: 'id', value: '{{id}}', enabled: true },
      { key: 'id', value: '7', enabled: true },
    ], vars);
    expect(url.href).toBe('https://example.com/items?id=42&id=7');
  });
  it('skips disabled rows', () => {
    const url = buildUrlFromRows('https://example.com', '/x', [
      { key: 'a', value: '1', enabled: false },
      { key: 'b', value: '2', enabled: true },
    ], {});
    expect(url.search).toBe('?b=2');
  });
  it('drops a query already in the path when rows exist (rows authoritative)', () => {
    const url = buildUrlFromRows('https://example.com', '/x?stale=1', [{ key: 'fresh', value: '2', enabled: true }], {});
    expect(url.search).toBe('?fresh=2');
  });
  it('keeps a path query when there are no rows', () => {
    const url = buildUrlFromRows('https://example.com', '/x?keep=1', [], {});
    expect(url.search).toBe('?keep=1');
  });
});

describe('buildUrl back-compat', () => {
  it('still resolves an absolute path verbatim', () => {
    const url = buildUrl('https://base.test', 'https://other.test/abs', {}, {});
    expect(url.href).toBe('https://other.test/abs');
  });
});
