/**
 * C0 — provider cache semantics over a fake companyStore slice.
 * The invalidation WIRING (session.config_updated → invalidate) lives in
 * wire-services; here we prove get() caches and invalidate() re-reads.
 */
import { describe, expect, it } from 'vitest';
import { createAutonomyProvider } from '../autonomy-provider.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const SESSION_ID = '00000000-0000-4000-8000-000000000007';
const MISSING_SESSION_ID = '00000000-0000-4000-8000-000000000099';

function fakeStore(initial: string | null) {
  let configJson = initial;
  let reads = 0;
  return {
    get reads() { return reads; },
    set(json: string | null) { configJson = json; },
    getCompanySession(_id: string) {
      reads += 1;
      return { config_json: configJson };
    },
  };
}

describe('createAutonomyProvider', () => {
  it('get() resolves from config_json and caches (one store read)', () => {
    const store = fakeStore(JSON.stringify({ autonomy: { scheduler: true } }));
    const provider = createAutonomyProvider({
      sessionSource: store,
      sessionId: SESSION_ID,
      env: EMPTY_ENV,
    });

    expect(provider.get().scheduler).toBe(true);
    expect(provider.get().scheduler).toBe(true);
    expect(store.reads).toBe(1);
  });

  it('invalidate() drops the cache — next get() sees the new config', () => {
    const store = fakeStore(JSON.stringify({ autonomy: { freeze: false } }));
    const provider = createAutonomyProvider({
      sessionSource: store,
      sessionId: SESSION_ID,
      env: EMPTY_ENV,
    });
    expect(provider.get().freeze).toBe(false);

    store.set(JSON.stringify({ autonomy: { freeze: true } }));
    expect(provider.get().freeze).toBe(false); // still cached
    provider.invalidate();
    expect(provider.get().freeze).toBe(true);
    expect(store.reads).toBe(2);
  });

  it('missing session row → env+defaults (never throws)', () => {
    const provider = createAutonomyProvider({
      sessionSource: { getCompanySession: () => null },
      sessionId: MISSING_SESSION_ID,
      env: { MCP_COMPANY_SCHEDULER: '1' },
    });
    const cfg = provider.get();
    expect(cfg.scheduler).toBe(true);
    expect(cfg.freeze).toBe(false);
  });

  it('store throwing → env+defaults (defensive read)', () => {
    const provider = createAutonomyProvider({
      sessionSource: { getCompanySession: () => { throw new Error('fs unavailable'); } },
      sessionId: MISSING_SESSION_ID,
      env: { MCP_COMPANY_SCHEDULER: '0' },
    });
    // The env kill-switch is honored on the fallback path (C2 default is ON).
    expect(provider.get().scheduler).toBe(false);
    const defaults = createAutonomyProvider({
      sessionSource: { getCompanySession: () => { throw new Error('fs unavailable'); } },
      sessionId: MISSING_SESSION_ID,
      env: EMPTY_ENV,
    });
    expect(defaults.get().scheduler).toBe(true);
  });
});
