import { describe, it, expect } from 'vitest';
import { runPreScript, runTestScript } from '../index.js';
import { UNSET } from '../types.js';

describe('runPreScript', () => {
  const reqSeed = () => ({ method: 'GET', url: '/x', headers: {} as Record<string, string>, body: '' });

  it('sets and unsets environment variables', async () => {
    const vars: Record<string, string> = { keep: '1' };
    const r = await runPreScript({
      source: `pm.environment.set('token', 'abc'); pm.environment.unset('keep');`,
      variables: vars, request: reqSeed(),
    });
    expect(r.variableUpdates.token).toBe('abc');
    expect(r.variableUpdates.keep).toBe(UNSET);
    expect(vars.token).toBe('abc');
    expect(vars.keep).toBeUndefined();
  });

  it('mutates the request and reports a patch', async () => {
    const seed = reqSeed();
    const r = await runPreScript({
      source: `pm.request.headers.set('X-Trace','1'); pm.request.method.set('POST');`,
      variables: {}, request: seed,
    });
    expect(seed.headers['X-Trace']).toBe('1');
    expect(seed.method).toBe('POST');
    expect(r.requestPatch?.headers).toEqual({ 'X-Trace': '1' });
    expect(r.requestPatch?.method).toBe('POST');
  });

  it('captures console.log', async () => {
    const r = await runPreScript({ source: `console.log('hi', 42)`, variables: {}, request: reqSeed() });
    expect(r.consoleLogs).toEqual(['hi 42']);
  });

  it('kills an infinite loop via the timeout', async () => {
    const r = await runPreScript({ source: `while(true){}`, variables: {}, request: reqSeed(), timeoutMs: 200 });
    expect(r.error).toBeTruthy();
  });

  it('blocks async escape — Promise/setTimeout are removed from the sandbox', async () => {
    const r = await runPreScript({ source: `Promise.resolve().then(() => {});`, variables: {}, request: reqSeed() });
    expect(r.error).toMatch(/Promise.*(not defined|not defined)|not defined.*Promise/);
    const t = await runPreScript({ source: `setTimeout(() => {}, 0);`, variables: {}, request: reqSeed() });
    expect(t.error).toMatch(/setTimeout.*not defined|not defined.*setTimeout/);
  });

  it('empty source is a no-op (no error)', async () => {
    const r = await runPreScript({ source: '   ', variables: {}, request: reqSeed() });
    expect(r.error).toBeUndefined();
    expect(r.tests).toEqual([]);
  });
});

describe('runTestScript', () => {
  const resp = (over: Partial<{ code: number; body: string }> = {}) => ({
    code: over.code ?? 200, status: 'OK', headers: { 'content-type': 'application/json' },
    body: over.body ?? '{"id":7,"name":"x"}', responseTime: 12,
  });
  const reqSeed = () => ({ method: 'GET', url: '/x', headers: {}, body: '' });

  it('passes status + property assertions', async () => {
    const r = await runTestScript({
      source: `
        pm.test('status', () => pm.expect(pm.response).to.have.status(200));
        pm.test('has id', () => pm.expect(pm.response.json()).to.have.property('id', 7));
      `,
      variables: {}, request: reqSeed(), response: resp(),
    });
    expect(r.tests).toEqual([
      { name: 'status', passed: true },
      { name: 'has id', passed: true },
    ]);
  });

  it('records a failing assertion with a message', async () => {
    const r = await runTestScript({
      source: `pm.test('wrong', () => pm.expect(pm.response.code).to.equal(404));`,
      variables: {}, request: reqSeed(), response: resp(),
    });
    expect(r.tests[0].passed).toBe(false);
    expect(r.tests[0].error).toContain('200');
  });

  it('captures a var set from the response', async () => {
    const r = await runTestScript({
      source: `pm.environment.set('id', String(pm.response.json().id));`,
      variables: {}, request: reqSeed(), response: resp(),
    });
    expect(r.variableUpdates.id).toBe('7');
  });

  it('request is read-only in a test script', async () => {
    const r = await runTestScript({
      source: `pm.test('mutate', () => { pm.request.method.set('POST'); });`,
      variables: {}, request: reqSeed(), response: resp(),
    });
    expect(r.tests[0].passed).toBe(false);
    expect(r.tests[0].error).toContain('read-only');
  });

  it('expect.not flips matchers; eql does deep equality; include works', async () => {
    const r = await runTestScript({
      source: `
        pm.test('not', () => pm.expect(1).to.not.equal(2));
        pm.test('eql', () => pm.expect(pm.response.json()).to.eql({id:7,name:'x'}));
        pm.test('include', () => pm.expect(pm.response.text()).to.include('"id":7'));
      `,
      variables: {}, request: reqSeed(), response: resp(),
    });
    expect(r.tests.every((t) => t.passed)).toBe(true);
  });
});
