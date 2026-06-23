import { describe, it, expect } from 'vitest';
import { buildCodegenRequest, generate } from '../index.js';
import type { ExecRequest } from '../../execute-request.js';

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  method: 'POST',
  path_template: '/users',
  headers_json: '[{"key":"Accept","value":"application/json","enabled":true}]',
  query_json: '[{"key":"page","value":"{{page}}","enabled":true}]',
  body_json: '{"name":"{{name}}"}',
  body_kind: 'json',
  auth_type: 'bearer',
  auth_json: '{"token":"{{tok}}"}',
  ...over,
});

const vars = { page: '2', name: 'joe', tok: 'SECRET123' };
const base = 'https://api.test';

describe('codegen — resolved vs template', () => {
  it('resolved form substitutes vars and folds auth into a header', () => {
    const cg = buildCodegenRequest({ request: req(), baseUrl: base, variables: vars, resolve: true });
    expect(cg.url).toBe('https://api.test/users?page=2');
    expect(cg.headers.find((h) => h.name === 'Authorization')?.value).toBe('Bearer SECRET123');
    const curl = generate('curl-bash', cg);
    expect(curl).toContain('https://api.test/users?page=2');
    expect(curl).toContain("Authorization: Bearer SECRET123");
    expect(curl).toContain('{"name":"joe"}');
  });

  it('template form keeps {{vars}} and never leaks the resolved secret', () => {
    const cg = buildCodegenRequest({ request: req(), baseUrl: base, variables: vars, resolve: false });
    const curl = generate('curl-bash', cg);
    expect(curl).toContain('{{page}}');
    expect(curl).toContain('Bearer {{tok}}');
    expect(curl).not.toContain('SECRET123');
  });
});

describe('codegen — targets', () => {
  const cg = buildCodegenRequest({ request: req(), baseUrl: base, variables: vars, resolve: true });
  it('powershell uses Invoke-RestMethod', () => {
    expect(generate('powershell', cg)).toContain('Invoke-RestMethod -Uri');
  });
  it('python uses requests', () => {
    const py = generate('python', cg);
    expect(py).toContain('import requests');
    expect(py).toContain('requests.request("POST"');
  });
  it('js-fetch emits fetch()', () => {
    expect(generate('js-fetch', cg)).toContain('fetch("https://api.test/users?page=2"');
  });
  it('cmd variant uses ^ continuation', () => {
    expect(generate('curl-cmd', cg)).toContain('^\n');
  });
});
