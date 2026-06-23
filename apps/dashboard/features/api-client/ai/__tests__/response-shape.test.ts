import { describe, it, expect } from 'vitest';
import { jsonShape } from '../response-shape.js';

describe('jsonShape', () => {
  it('replaces primitives with their type names — never the real value', () => {
    const out = jsonShape('{"token":"secret-abc","count":3,"ok":true,"missing":null}');
    expect(out).toBe(JSON.stringify({ token: 'string', count: 'number', ok: 'boolean', missing: 'null' }, null, 2));
    expect(out).not.toContain('secret-abc');
    expect(out).not.toContain('3');
  });

  it('shapes arrays from the first element', () => {
    expect(jsonShape('[{"id":1,"name":"x"}]')).toBe(JSON.stringify([{ id: 'number', name: 'string' }], null, 2));
    expect(jsonShape('[]')).toBe(JSON.stringify(['…'], null, 2));
  });

  it('shapes nested objects', () => {
    const out = jsonShape('{"user":{"id":1,"tags":["a","b"]}}');
    expect(out).toBe(JSON.stringify({ user: { id: 'number', tags: ['string'] } }, null, 2));
  });

  it('returns undefined for non-JSON or empty bodies', () => {
    expect(jsonShape('not json')).toBeUndefined();
    expect(jsonShape('')).toBeUndefined();
    expect(jsonShape(null)).toBeUndefined();
    expect(jsonShape(undefined)).toBeUndefined();
  });

  it('caps depth so deeply nested values are summarized, not leaked', () => {
    const out = jsonShape('{"a":{"b":{"c":{"d":{"e":"deep-secret"}}}}}');
    expect(out).not.toContain('deep-secret');
  });
});
