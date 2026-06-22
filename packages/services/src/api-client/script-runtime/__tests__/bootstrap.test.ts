/**
 * Validates the in-isolate BOOTSTRAP logic (pm/expect/console/accumulation)
 * using node:vm — which is always available — so the pm.* surface is verified in
 * CI WITHOUT needing the native isolated-vm binary. The isolated-vm wrapper
 * (index.ts) is thin and covered separately (ABI-gated). This test also guards
 * against bundler-helper injection (e.g. esbuild's `__name`) breaking the
 * serialized source.
 */
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { BOOTSTRAP } from '../bootstrap.js';
import { UNSET } from '../types.js';

interface Collected {
  variableUpdates: Record<string, string>;
  requestPatch?: { url?: string; method?: string; headers?: Record<string, string>; removedHeaders?: string[]; body?: string };
  consoleLogs: string[];
  tests: { name: string; passed: boolean; error?: string }[];
  error?: string;
}

function run(phase: 'pre' | 'test', source: string, extra: {
  variables?: Record<string, string>;
  request?: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { code: number; status: string; headers: Record<string, string>; body: string; responseTime: number } | null;
} = {}): Collected {
  const ctx: Record<string, unknown> = vm.createContext({});
  ctx.__PM_INPUT__ = JSON.stringify({
    phase,
    variables: extra.variables ?? {},
    request: extra.request ?? { method: 'GET', url: '/x', headers: {}, body: '' },
    response: extra.response ?? null,
    cookies: [],
    UNSET,
  });
  vm.runInContext(BOOTSTRAP, ctx);
  let error: string | undefined;
  try { vm.runInContext(`(function(){\n${source}\n})()`, ctx); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  return { ...(JSON.parse(vm.runInContext('__pmCollect()', ctx)) as Collected), error };
}

const resp = () => ({ code: 200, status: 'OK', headers: { 'content-type': 'application/json' }, body: '{"id":7,"name":"x"}', responseTime: 12 });

describe('pm bootstrap (under node:vm)', () => {
  it('sets/unsets env vars and records a request patch (pre)', () => {
    const r = run('pre', `pm.environment.set('token','abc'); pm.environment.unset('keep'); pm.request.headers.set('X-Trace','1'); pm.request.method.set('POST');`, { variables: { keep: '1' } });
    expect(r.variableUpdates.token).toBe('abc');
    expect(r.variableUpdates.keep).toBe(UNSET);
    expect(r.requestPatch?.headers).toEqual({ 'X-Trace': '1' });
    expect(r.requestPatch?.method).toBe('POST');
  });

  it('captures console.log', () => {
    expect(run('pre', `console.log('hi', 42)`).consoleLogs).toEqual(['hi 42']);
  });

  it('runs status/property/eql/not/include assertions and saves a response var (test)', () => {
    const r = run('test', `
      pm.test('status', () => pm.expect(pm.response).to.have.status(200));
      pm.test('has id', () => pm.expect(pm.response.json()).to.have.property('id', 7));
      pm.test('eql', () => pm.expect(pm.response.json()).to.eql({id:7,name:'x'}));
      pm.test('not', () => pm.expect(1).to.not.equal(2));
      pm.test('include', () => pm.expect(pm.response.text()).to.include('"id":7'));
      pm.environment.set('id', String(pm.response.json().id));
    `, { response: resp() });
    expect(r.tests.every((t) => t.passed)).toBe(true);
    expect(r.variableUpdates.id).toBe('7');
  });

  it('records a failing assertion with a message', () => {
    const r = run('test', `pm.test('wrong', () => pm.expect(pm.response.code).to.equal(404));`, { response: resp() });
    expect(r.tests[0].passed).toBe(false);
    expect(r.tests[0].error).toContain('200');
  });

  it('makes pm.request read-only in a test script', () => {
    const r = run('test', `pm.test('mut', () => { pm.request.method.set('POST'); });`, { response: resp() });
    expect(r.tests[0].passed).toBe(false);
    expect(r.tests[0].error).toContain('read-only');
  });

  it('removes async globals (Promise) inside the sandbox', () => {
    expect(run('pre', `Promise.resolve().then(()=>{})`).error).toMatch(/Promise is not defined/);
  });

  it('does not leak bundler helpers — the serialized source is self-sufficient', () => {
    // Would throw "__name is not defined" without the prepended shim.
    expect(() => run('pre', `pm.environment.set('a','1')`)).not.toThrow();
  });
});
