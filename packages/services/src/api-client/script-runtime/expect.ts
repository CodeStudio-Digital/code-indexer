/**
 * Minimal chai-like `expect` for test scripts. Not a full chai — just the
 * matchers Postman users reach for. Language chains (.to/.be/.have/.and/.is/
 * .that/.which) are no-op getters returning `this`; `.not` flips a negate flag
 * consumed by every terminal matcher. A failed matcher throws AssertionError;
 * the message is what pm.test records.
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const LANGUAGE = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same'];

class Assertion {
  private negate = false;
  constructor(private actual: unknown) {
    for (const word of LANGUAGE) {
      Object.defineProperty(this, word, { get: () => this });
    }
  }

  get not(): this { this.negate = !this.negate; return this; }

  private check(pass: boolean, msg: string, negMsg: string): void {
    if (this.negate ? pass : !pass) throw new AssertionError(this.negate ? negMsg : msg);
  }

  private get respStatus(): number | undefined {
    const a = this.actual as { code?: number; status?: number } | number;
    if (typeof a === 'number') return a;
    return a?.code ?? a?.status;
  }

  equal(x: unknown): this { this.check(this.actual === x, `expected ${j(this.actual)} to equal ${j(x)}`, `expected ${j(this.actual)} to not equal ${j(x)}`); return this; }
  eq(x: unknown): this { return this.equal(x); }
  eql(x: unknown): this { this.check(deepEqual(this.actual, x), `expected ${j(this.actual)} to deeply equal ${j(x)}`, `expected values to differ`); return this; }
  a(t: string): this { this.check(typeOf(this.actual) === t, `expected ${j(this.actual)} to be a ${t}`, `expected not to be a ${t}`); return this; }
  an(t: string): this { return this.a(t); }
  above(n: number): this { this.check(Number(this.actual) > n, `expected ${j(this.actual)} to be above ${n}`, `expected ${j(this.actual)} to not be above ${n}`); return this; }
  below(n: number): this { this.check(Number(this.actual) < n, `expected ${j(this.actual)} to be below ${n}`, `expected ${j(this.actual)} to not be below ${n}`); return this; }
  least(n: number): this { this.check(Number(this.actual) >= n, `expected ${j(this.actual)} to be at least ${n}`, `expected ${j(this.actual)} to be below ${n}`); return this; }
  most(n: number): this { this.check(Number(this.actual) <= n, `expected ${j(this.actual)} to be at most ${n}`, `expected ${j(this.actual)} to be above ${n}`); return this; }

  get ok(): this { this.check(!!this.actual, `expected ${j(this.actual)} to be truthy`, `expected ${j(this.actual)} to be falsy`); return this; }
  get true(): this { this.check(this.actual === true, `expected ${j(this.actual)} to be true`, `expected not true`); return this; }
  get false(): this { this.check(this.actual === false, `expected ${j(this.actual)} to be false`, `expected not false`); return this; }
  get null(): this { this.check(this.actual === null, `expected ${j(this.actual)} to be null`, `expected not null`); return this; }
  get undefined(): this { this.check(this.actual === undefined, `expected ${j(this.actual)} to be undefined`, `expected not undefined`); return this; }
  get empty(): this { const len = lengthOf(this.actual); this.check(len === 0, `expected ${j(this.actual)} to be empty`, `expected not empty`); return this; }

  property(name: string, value?: unknown): this {
    const obj = this.actual as Record<string, unknown>;
    const has = !!obj && typeof obj === 'object' && name in obj;
    this.check(has, `expected object to have property '${name}'`, `expected object to not have property '${name}'`);
    if (value !== undefined && has) this.check(deepEqual(obj[name], value), `expected property '${name}' to equal ${j(value)}`, `expected property '${name}' to differ`);
    return this;
  }

  include(sub: unknown): this {
    let pass = false;
    if (typeof this.actual === 'string') pass = this.actual.includes(String(sub));
    else if (Array.isArray(this.actual)) pass = this.actual.some((x) => deepEqual(x, sub));
    else if (this.actual && typeof this.actual === 'object' && sub && typeof sub === 'object') {
      pass = Object.entries(sub).every(([k, v]) => deepEqual((this.actual as Record<string, unknown>)[k], v));
    }
    this.check(pass, `expected ${j(this.actual)} to include ${j(sub)}`, `expected ${j(this.actual)} to not include ${j(sub)}`);
    return this;
  }
  includes(sub: unknown): this { return this.include(sub); }
  contain(sub: unknown): this { return this.include(sub); }

  status(code: number): this {
    const s = this.respStatus;
    this.check(s === code, `expected status ${s} to be ${code}`, `expected status to not be ${code}`);
    return this;
  }
}

function lengthOf(v: unknown): number {
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return -1;
}

function j(v: unknown): string {
  try { return typeof v === 'string' ? `'${v}'` : JSON.stringify(v); } catch { return String(v); }
}

export function expect(actual: unknown): Assertion {
  return new Assertion(actual);
}
