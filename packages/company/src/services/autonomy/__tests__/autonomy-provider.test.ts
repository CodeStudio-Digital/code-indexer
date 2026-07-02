/**
 * C0 — provider cache semantics over a fake companyStore slice.
 * The invalidation WIRING (session.config_updated → invalidate) lives in
 * wire-services; here we prove get() caches and invalidate() re-reads.
 */
import { describe, expect, it } from 'vitest';
import { createAutonomyProvider } from '../autonomy-provider.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

function fakeStore(initial: string | null) {
  let configJson = initial;
  let reads = 0;
  return {
    get reads() { return reads; },
    set(json: string | null) { configJson = json; },
    getCompanySession(_id: number) {
      reads += 1;
      return { config_json: configJson };
    },
  };
}

describe('createAutonomyProvider', () => {
  it('get() resolves from config_json and caches (one store read)', () => {
    const store = fakeStore(JSON.stringify({ autonomy: { scheduler: true } }));
    const provider = createAutonomyProvider({ companyStore: store, sessionId: 7, env: EMPTY_ENV });

    expect(provider.get().scheduler).toBe(true);
    expect(provider.get().scheduler).toBe(true);
    expect(store.reads).toBe(1);
  });

  it('invalidate() drops the cache — next get() sees the new config', () => {
    const store = fakeStore(JSON.stringify({ autonomy: { freeze: false } }));
    const provider = createAutonomyProvider({ companyStore: store, sessionId: 7, env: EMPTY_ENV });
    expect(provider.get().freeze).toBe(false);

    store.set(JSON.stringify({ autonomy: { freeze: true } }));
    expect(provider.get().freeze).toBe(false); // still cached
    provider.invalidate();
    expect(provider.get().freeze).toBe(true);
    expect(store.reads).toBe(2);
  });

  it('missing session row → env+defaults (never throws)', () => {
    const provider = createAutonomyProvider({
      companyStore: { getCompanySession: () => null },
      sessionId: 99,
      env: { MCP_COMPANY_SCHEDULER: '1' },
    });
    const cfg = provider.get();
    expect(cfg.scheduler).toBe(true);
    expect(cfg.freeze).toBe(false);
  });

  it('store throwing → env+defaults (defensive read)', () => {
    const provider = createAutonomyProvider({
      companyStore: { getCompanySession: () => { throw new Error('db locked'); } },
      sessionId: 99,
      env: { MCP_COMPANY_SCHEDULER: '0' },
    });
    // The env kill-switch is honored on the fallback path (C2 default is ON).
    expect(provider.get().scheduler).toBe(false);
    const defaults = createAutonomyProvider({
      companyStore: { getCompanySession: () => { throw new Error('db locked'); } },
      sessionId: 99,
      env: EMPTY_ENV,
    });
    expect(defaults.get().scheduler).toBe(true);
  });
});
