import { describe, it, expect } from 'vitest';
import { extractFtsTokens, buildContentMatchQuery } from '../content-grep.js';

describe('content-grep token extraction', () => {
  it('splits snake_case like unicode61 does; keeps camelCase whole', () => {
    expect(extractFtsTokens('embedding_hash', true)).toEqual(['embedding', 'hash']);
    expect(extractFtsTokens('handleChange', true)).toEqual(['handlechange']);
  });

  it('strips regex escape classes and short tokens', () => {
    expect(extractFtsTokens('\\bfoo\\d+bar\\w', false)).toEqual(['foo', 'bar']);
    expect(extractFtsTokens('a|b|cd', false)).toEqual([]); // all < 3 chars
  });

  it('builds AND for literals, OR for regex, null when tokenless', () => {
    expect(buildContentMatchQuery('rotate_keys', true)).toBe('rotate* AND keys*');
    expect(buildContentMatchQuery('handle(Change|Click)', false)).toBe('handle* OR change* OR click*');
    expect(buildContentMatchQuery('^\\s*$', false)).toBeNull();
  });

  it('caps and dedupes tokens', () => {
    const q = extractFtsTokens('aaa aaa bbb ccc ddd eee fff ggg hhh iii jjj', true);
    expect(q.length).toBeLessThanOrEqual(8);
    expect(new Set(q).size).toBe(q.length);
  });
});
