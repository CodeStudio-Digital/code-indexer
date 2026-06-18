import { describe, it, expect } from 'vitest';
import { computeAuth, mergeAuthHeaders } from '../apply-auth.js';
import { parseAuth } from '../auth-types.js';

describe('parseAuth', () => {
  it('fails safe to none on garbage', () => {
    expect(parseAuth('bearer', 'not json')).toEqual({ type: 'bearer', token: '' });
    expect(parseAuth(null, null)).toEqual({ type: 'none' });
  });
});

describe('computeAuth', () => {
  it('bearer resolves the token', () => {
    const a = computeAuth({ type: 'bearer', token: '{{tok}}' }, { tok: 'abc' }, true);
    expect(a.headers['Authorization']).toBe('Bearer abc');
  });

  it('bearer template form keeps {{tok}}', () => {
    const a = computeAuth({ type: 'bearer', token: '{{tok}}' }, {}, false);
    expect(a.headers['Authorization']).toBe('Bearer {{tok}}');
  });

  it('basic base64-encodes user:pass', () => {
    const a = computeAuth({ type: 'basic', username: 'u', password: 'p' }, {}, true);
    expect(a.headers['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('apikey in query', () => {
    const a = computeAuth({ type: 'apikey', key: 'k', value: 'v', in: 'query' }, {}, true);
    expect(a.query).toEqual({ k: 'v' });
    expect(a.headers).toEqual({});
  });

  it('oauth2 honors a custom prefix', () => {
    const a = computeAuth({ type: 'oauth2', token: 't', headerPrefix: 'Token' }, {}, true);
    expect(a.headers['Authorization']).toBe('Token t');
  });
});

describe('mergeAuthHeaders', () => {
  it('explicit header wins over auth (case-insensitive)', () => {
    const headers = { authorization: 'Bearer explicit' };
    mergeAuthHeaders(headers, { Authorization: 'Bearer auth' });
    expect(headers).toEqual({ authorization: 'Bearer explicit' });
  });
  it('adds auth header when absent', () => {
    const headers: Record<string, string> = {};
    mergeAuthHeaders(headers, { Authorization: 'Bearer auth' });
    expect(headers['Authorization']).toBe('Bearer auth');
  });
});
