/**
 * Bootstrap source executed INSIDE the isolated-vm isolate.
 *
 * It reads the JSON input from the `__PM_INPUT__` global, builds the Postman-style
 * `pm`, `console` and `expect` surface from the isolate's OWN intrinsics (never a
 * host object — passing a host object is what makes node:vm unsafe, and
 * isolated-vm forbids it outright), accumulates results, and exposes
 * `__pmCollect()` which returns the accumulated result as a JSON string. Inputs
 * and outputs cross the isolate boundary ONLY as JSON strings (primitives), so no
 * live host reference is ever reachable from a script.
 *
 * Authored as a real function and serialized via `.toString()` so the logic keeps
 * TypeScript checking and we avoid hand-escaping a giant template string (the
 * matcher messages are template literals — they must stay un-interpolated until
 * they run in the isolate). The function MUST be self-contained: it may reference
 * only isolate globals (globalThis/JSON/Object/Array/Map/Number/String/Error),
 * never an imported or outer symbol.
 */
function pmBootstrap(): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const input = JSON.parse(g.__PM_INPUT__);
  const UNSET: string = input.UNSET;
  const isPre = input.phase === 'pre';

  const variables: Record<string, string> = input.variables || {};
  const variableUpdates: Record<string, string> = {};
  const consoleLogs: string[] = [];
  const tests: Array<{ name: string; passed: boolean; error?: string }> = [];
  const patch: any = { headers: {}, removedHeaders: [] };

  const MAX_LOG_BYTES = 32 * 1024;
  let logBytes = 0;
  const safe = (x: any): string => { try { return JSON.stringify(x); } catch { return String(x); } };
  const log = (...a: any[]): void => {
    if (logBytes >= MAX_LOG_BYTES) return;
    const line = a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ');
    logBytes += line.length;
    consoleLogs.push(line);
  };

  const findHeader = (h: Record<string, string>, name: string): string | undefined => {
    const lower = name.toLowerCase();
    for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
    return undefined;
  };

  const req = input.request;
  const resp = input.response;
  const cookies = new Map<string, string>(input.cookies || []);
  const guard = (): void => { if (!isPre) throw new Error('pm.request is read-only in a test script'); };

  // ── Minimal chai-like expect (factory, no class — keeps .toString() simple) ──
  const typeOf = (v: any): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  const deepEqual = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  };
  const lengthOf = (v: any): number => {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return -1;
  };
  const j = (v: any): string => { try { return typeof v === 'string' ? `'${v}'` : JSON.stringify(v); } catch { return String(v); } };
  const LANG = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same'];

  const expect = (actual: any): any => {
    let negate = false;
    const self: any = {};
    const check = (pass: boolean, msg: string, negMsg: string): void => {
      if (negate ? pass : !pass) throw new Error(negate ? negMsg : msg);
    };
    const respStatus = (): number | undefined => {
      if (typeof actual === 'number') return actual;
      return actual == null ? undefined : (actual.code ?? actual.status);
    };
    for (const w of LANG) Object.defineProperty(self, w, { get: () => self });
    Object.defineProperty(self, 'not', { get: () => { negate = !negate; return self; } });
    Object.defineProperty(self, 'ok', { get: () => { check(!!actual, `expected ${j(actual)} to be truthy`, `expected ${j(actual)} to be falsy`); return self; } });
    Object.defineProperty(self, 'true', { get: () => { check(actual === true, `expected ${j(actual)} to be true`, `expected not true`); return self; } });
    Object.defineProperty(self, 'false', { get: () => { check(actual === false, `expected ${j(actual)} to be false`, `expected not false`); return self; } });
    Object.defineProperty(self, 'null', { get: () => { check(actual === null, `expected ${j(actual)} to be null`, `expected not null`); return self; } });
    Object.defineProperty(self, 'undefined', { get: () => { check(actual === undefined, `expected ${j(actual)} to be undefined`, `expected not undefined`); return self; } });
    Object.defineProperty(self, 'empty', { get: () => { check(lengthOf(actual) === 0, `expected ${j(actual)} to be empty`, `expected not empty`); return self; } });
    self.equal = (x: any): any => { check(actual === x, `expected ${j(actual)} to equal ${j(x)}`, `expected ${j(actual)} to not equal ${j(x)}`); return self; };
    self.eq = self.equal;
    self.eql = (x: any): any => { check(deepEqual(actual, x), `expected ${j(actual)} to deeply equal ${j(x)}`, `expected values to differ`); return self; };
    self.a = (t: string): any => { check(typeOf(actual) === t, `expected ${j(actual)} to be a ${t}`, `expected not to be a ${t}`); return self; };
    self.an = self.a;
    self.above = (n: number): any => { check(Number(actual) > n, `expected ${j(actual)} to be above ${n}`, `expected ${j(actual)} to not be above ${n}`); return self; };
    self.below = (n: number): any => { check(Number(actual) < n, `expected ${j(actual)} to be below ${n}`, `expected ${j(actual)} to not be below ${n}`); return self; };
    self.least = (n: number): any => { check(Number(actual) >= n, `expected ${j(actual)} to be at least ${n}`, `expected ${j(actual)} to be below ${n}`); return self; };
    self.most = (n: number): any => { check(Number(actual) <= n, `expected ${j(actual)} to be at most ${n}`, `expected ${j(actual)} to be above ${n}`); return self; };
    self.property = (name: string, value?: any): any => {
      const obj = actual;
      const has = !!obj && typeof obj === 'object' && name in obj;
      check(has, `expected object to have property '${name}'`, `expected object to not have property '${name}'`);
      if (value !== undefined && has) check(deepEqual(obj[name], value), `expected property '${name}' to equal ${j(value)}`, `expected property '${name}' to differ`);
      return self;
    };
    self.include = (sub: any): any => {
      let pass = false;
      if (typeof actual === 'string') pass = actual.includes(String(sub));
      else if (Array.isArray(actual)) pass = actual.some((x: any) => deepEqual(x, sub));
      else if (actual && typeof actual === 'object' && sub && typeof sub === 'object') pass = Object.keys(sub).every((k) => deepEqual(actual[k], sub[k]));
      check(pass, `expected ${j(actual)} to include ${j(sub)}`, `expected ${j(actual)} to not include ${j(sub)}`);
      return self;
    };
    self.includes = self.include;
    self.contain = self.include;
    self.status = (code: number): any => { const s = respStatus(); check(s === code, `expected status ${s} to be ${code}`, `expected status to not be ${code}`); return self; };
    return self;
  };

  const pm = {
    environment: {
      get: (k: string) => variables[k],
      set: (k: string, v: any) => { const s = String(v); variables[k] = s; variableUpdates[k] = s; },
      unset: (k: string) => { delete variables[k]; variableUpdates[k] = UNSET; },
    },
    variables: { get: (k: string) => variables[k] },
    cookies: { get: (n: string) => cookies.get(n), has: (n: string) => cookies.has(n) },
    request: {
      url: { get: () => req.url, set: (v: string) => { guard(); req.url = v; patch.url = v; } },
      method: { get: () => req.method, set: (v: string) => { guard(); req.method = v; patch.method = v; } },
      headers: {
        get: (n: string) => findHeader(req.headers, n),
        all: () => ({ ...req.headers }),
        set: (n: string, v: string) => { guard(); req.headers[n] = v; patch.headers[n] = v; },
        remove: (n: string) => { guard(); delete req.headers[n]; patch.removedHeaders.push(n); },
      },
      body: { get: () => req.body, set: (v: string) => { guard(); req.body = v; patch.body = v; } },
    },
    response: resp ? {
      code: resp.code,
      status: resp.status,
      responseTime: resp.responseTime,
      headers: {
        get: (n: string) => findHeader(resp.headers, n),
        has: (n: string) => findHeader(resp.headers, n) !== undefined,
        all: () => ({ ...resp.headers }),
      },
      text: () => resp.body,
      json: () => JSON.parse(resp.body),
    } : undefined,
    expect,
    test: (name: string, fn: () => void) => {
      try { fn(); tests.push({ name, passed: true }); }
      catch (e: any) { tests.push({ name, passed: false, error: e && e.message ? String(e.message) : String(e) }); }
    },
  };

  g.pm = pm;
  g.console = { log, warn: log, error: log, info: log, debug: log };
  g.__pmCollect = (): string => {
    const requestPatch = isPre ? {
      url: patch.url,
      method: patch.method,
      headers: Object.keys(patch.headers).length ? patch.headers : undefined,
      removedHeaders: patch.removedHeaders.length ? patch.removedHeaders : undefined,
      body: patch.body,
    } : undefined;
    return JSON.stringify({ variableUpdates, requestPatch, consoleLogs, tests });
  };

  // Strictly synchronous: remove async-capable globals so a script can't defer
  // work past the isolate's synchronous timeout (and to keep the existing
  // "Promise is not defined" contract). setTimeout/setInterval/setImmediate
  // are not present in a bare isolate anyway.
  for (const k of ['Promise', 'queueMicrotask', 'setTimeout', 'setInterval', 'setImmediate', 'WeakRef', 'FinalizationRegistry']) {
    try { delete g[k]; } catch { /* non-configurable — ignore */ }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * The bootstrap as an IIFE source string, run once per isolate before the user
 * script. A `__name` shim is prepended because esbuild's `keepNames` (used by
 * vitest and most app builds) wraps inner functions with a free `__name(...)`
 * reference that does not exist inside the isolate; the shim makes the serialized
 * source self-sufficient under esbuild AND tsc (where it's simply unused). This
 * is exercised by bootstrap.test.ts under node:vm so a regression fails fast.
 */
export const BOOTSTRAP = `var __name=function(t){return t;};(${pmBootstrap.toString()})()`;
