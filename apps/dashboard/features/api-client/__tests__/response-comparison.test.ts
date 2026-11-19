import { describe, expect, it } from 'vitest';
import { compareBodies } from '../response/compare-responses.js';
import { withQuery, useQuerySync } from '../useQuerySync.js';
import type { KvRow, SendResponse } from '../types.js';

const response = (body: string): SendResponse => ({ body, headers: {}, status: 200, statusText: 'OK', ms: 4, url: 'http://localhost' });
describe('response comparison', () => {
  it('ignores JSON key order and compares by escaped path, including falsy values', () => {
    const result = compareBodies(response('{"b":1,"a/b~":[null,0],"__proto__":1}'), response('{"__proto__":2,"a/b~":[null,false,""],"b":1}'));
    expect(result).toEqual({ limited: false, changes: [
      { path: '/a~1b~0/1', before: '0', after: 'false' },
      { path: '/a~1b~0/2', before: undefined, after: '""' },
      { path: '/__proto__', before: '1', after: '2' },
    ] });
  });
  it('compares non-JSON text by line and marks limits and truncated input', () => {
    expect(compareBodies(response('one\ntwo'), response('one\nnew')).changes).toEqual([{ path: '2', before: '"two"', after: '"new"' }]);
    expect(compareBodies(response('a\n'.repeat(140)), response('b\n'.repeat(140)))).toMatchObject({ limited: true, changes: Array(100).fill(expect.anything()) });
    expect(compareBodies({ ...response('x'), truncated: true }, response('x')).limited).toBe(true);
    expect(compareBodies(response('x'.repeat(300000)), response('y')).limited).toBe(true);
  });
});

it('round-trips repeated and escaped query values, templates, disabled rows and fragments', () => {
  const rows: KvRow[] = [];
  useQuerySync({ pathTemplate: '/x', queryRows: [{ key: 'off', value: '1', enabled: false }], onPath: () => {}, onQuery: v => rows.push(...v) })
    .onUrlEdit('/x?tag=a%26b&tag=two+words&key={{token}}&p=%2F#view');
  expect(rows.map(r => r.value)).toEqual(['1', 'a&b', 'two words', '{{token}}', '/']);
  expect(withQuery('/x?old=yes#view', rows)).toBe('/x?tag=a%26b&tag=two+words&key={{token}}&p=%2F#view');
});
