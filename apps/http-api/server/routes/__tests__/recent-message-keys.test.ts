/**
 * Unit tests for the RecentMessageKeys idempotency store + normalizeDedupeKey.
 * Pure/in-memory — no route mount, no ABI, no fake timers (TTL uses an injected
 * clock).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RecentMessageKeys, normalizeDedupeKey } from '../recent-message-keys.js';

// Minimal structural bus — the store only holds a WeakRef and never reads it.
function fakeBus(id: string): { busId: string; ended: boolean } {
  return { busId: id, ended: false };
}

const SESSION_1 = '00000000-0000-4000-8000-000000000001';
const SESSION_2 = '00000000-0000-4000-8000-000000000002';
const SESSION_3 = '00000000-0000-4000-8000-000000000003';

describe('RecentMessageKeys', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('returns the recorded bus + sinceHint on a lookup hit', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    const bus = fakeBus('a');
    store.record(SESSION_1, 'k', bus, 7);
    expect(store.lookup(SESSION_1, 'k')).toEqual({ bus, sinceHint: 7 });
  });

  it('misses on an unknown key or session', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    store.record(SESSION_1, 'k', fakeBus('a'), 0);
    expect(store.lookup(SESSION_1, 'other')).toBeUndefined();
    expect(store.lookup(SESSION_2, 'k')).toBeUndefined();
  });

  it('isolates identical keys across sessions', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    const b1 = fakeBus('a');
    const b2 = fakeBus('b');
    store.record(SESSION_1, 'k', b1, 1);
    store.record(SESSION_2, 'k', b2, 2);
    expect(store.lookup(SESSION_1, 'k')?.bus).toBe(b1);
    expect(store.lookup(SESSION_2, 'k')?.bus).toBe(b2);
  });

  it('keeps an exact live bus past TTL and expires it after it ends', () => {
    let now = 1000;
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ ttlMs: 100, now: () => now });
    const bus = fakeBus('a');
    store.record(SESSION_1, 'k', bus, 0);
    now = 1099;
    expect(store.lookup(SESSION_1, 'k')).toBeDefined();
    now = 1101;
    expect(store.lookup(SESSION_1, 'k')?.bus).toBe(bus);
    bus.ended = true;
    now = 1202;
    expect(store.lookup(SESSION_1, 'k')).toBeUndefined();
  });

  it('rejects the same key with a different payload while its owner is pending', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    expect(store.claim(SESSION_1, 'k', 'payload-a').kind).toBe('owner');
    expect(store.claim(SESSION_1, 'k', 'payload-b')).toEqual({ kind: 'payload_conflict' });
  });

  it('treats a collected WeakRef as a cache miss that needs durable resolution', () => {
    vi.stubGlobal('WeakRef', class {
      constructor(_value: object) {}
      deref() { return undefined; }
    });
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    store.record(SESSION_1, 'k', fakeBus('collected'), 0);

    expect(store.claim(SESSION_1, 'k', '')).toMatchObject({ kind: 'owner' });
  });

  it('bounds a duplicate wait when the owner never settles', async () => {
    vi.useFakeTimers();
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({
      ttlMs: 60_000,
      pendingWaitMs: 50,
    });
    const owner = store.claim(SESSION_1, 'k', 'payload-a');
    expect(owner.kind).toBe('owner');
    const duplicate = store.claim(SESSION_1, 'k', 'payload-a');
    expect(duplicate.kind).toBe('existing');
    const settled = duplicate.kind === 'existing' ? duplicate.settled : Promise.reject();

    await vi.advanceTimersByTimeAsync(51);
    await expect(settled).resolves.toMatchObject({
      retryLater: {
        reason: 'idempotency-owner-pending',
        retryAfterMs: 50,
      },
    });
    expect(vi.getTimerCount()).toBe(0);
    if (owner.kind !== 'owner') throw new Error('owner expected');
    const bus = fakeBus('eventual-owner');
    expect(store.record(SESSION_1, 'k', bus, -1, {
      token: owner.token,
      fingerprintHash: 'payload-a',
    })).toBe(true);
    expect(store.lookup(SESSION_1, 'k')?.bus).toBe(bus);
  });

  it('preserves all 32 live owner guards across TTL and refuses the 33rd claim', async () => {
    vi.useFakeTimers();
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({
      ttlMs: 25,
      pendingWaitMs: 25,
    });
    const owners = Array.from({ length: 32 }, (_, index) => ({
      key: `k-${index}`,
      claim: store.claim(SESSION_1, `k-${index}`, `payload-${index}`),
    }));
    expect(owners.every(({ claim }) => claim.kind === 'owner')).toBe(true);
    expect(store.claim(SESSION_1, 'k-32', 'payload-32')).toEqual({
      kind: 'capacity_exhausted',
      retryAfterMs: 25,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(store.claim(SESSION_1, 'k-32', 'payload-32')).toEqual({
      kind: 'capacity_exhausted',
      retryAfterMs: 25,
    });

    for (const [index, owner] of owners.entries()) {
      if (owner.claim.kind !== 'owner') throw new Error('owner expected');
      expect(store.record(SESSION_1, owner.key, fakeBus(`bus-${index}`), -1, {
        token: owner.claim.token,
        fingerprintHash: `payload-${index}`,
      })).toBe(true);
    }
  });

  it('does not evict a pending session at the global session cap', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({
      maxSessions: 2,
      maxPerSession: 1,
    });
    expect(store.claim(SESSION_1, 'a', 'a').kind).toBe('owner');
    expect(store.claim(SESSION_2, 'b', 'b').kind).toBe('owner');
    expect(store.claim(SESSION_3, 'c', 'c')).toMatchObject({ kind: 'capacity_exhausted' });
  });

  it('evicts the oldest key once the per-session cap is exceeded (LRU)', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    store.record(SESSION_1, 'a', fakeBus('a'), 0);
    store.record(SESSION_1, 'b', fakeBus('b'), 0);
    store.record(SESSION_1, 'c', fakeBus('c'), 0); // evicts 'a'
    expect(store.lookup(SESSION_1, 'a')).toBeUndefined();
    expect(store.lookup(SESSION_1, 'b')).toBeDefined();
    expect(store.lookup(SESSION_1, 'c')).toBeDefined();
  });

  it('re-recording a key refreshes its LRU position', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    store.record(SESSION_1, 'a', fakeBus('a'), 0);
    store.record(SESSION_1, 'b', fakeBus('b'), 0);
    store.record(SESSION_1, 'a', fakeBus('a2'), 0); // 'a' back to MRU
    store.record(SESSION_1, 'c', fakeBus('c'), 0); // evicts 'b' (now oldest), not 'a'
    expect(store.lookup(SESSION_1, 'a')).toBeDefined();
    expect(store.lookup(SESSION_1, 'b')).toBeUndefined();
    expect(store.lookup(SESSION_1, 'c')).toBeDefined();
  });

  it('claim and lookup hits refresh ready-entry LRU recency', async () => {
    const byClaim = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    byClaim.record(SESSION_1, 'a', fakeBus('a'), 0);
    byClaim.record(SESSION_1, 'b', fakeBus('b'), 0);
    const hit = byClaim.claim(SESSION_1, 'a', '');
    expect(hit.kind).toBe('existing');
    if (hit.kind !== 'existing') throw new Error('existing hit expected');
    expect(await hit.settled).toBeDefined();
    byClaim.record(SESSION_1, 'c', fakeBus('c'), 0);
    expect(byClaim.lookup(SESSION_1, 'a')).toBeDefined();
    expect(byClaim.lookup(SESSION_1, 'b')).toBeUndefined();

    const byLookup = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    byLookup.record(SESSION_1, 'a', fakeBus('a'), 0);
    byLookup.record(SESSION_1, 'b', fakeBus('b'), 0);
    expect(byLookup.lookup(SESSION_1, 'a')).toBeDefined();
    byLookup.record(SESSION_1, 'c', fakeBus('c'), 0);
    expect(byLookup.lookup(SESSION_1, 'a')).toBeDefined();
    expect(byLookup.lookup(SESSION_1, 'b')).toBeUndefined();
  });
});

describe('normalizeDedupeKey', () => {
  it('accepts a sane non-empty string', () => {
    expect(normalizeDedupeKey('abc')).toBe('abc');
  });

  it('rejects non-strings, empty, and overlong values', () => {
    expect(normalizeDedupeKey(undefined)).toBeUndefined();
    expect(normalizeDedupeKey(null)).toBeUndefined();
    expect(normalizeDedupeKey(123)).toBeUndefined();
    expect(normalizeDedupeKey('')).toBeUndefined();
    expect(normalizeDedupeKey('x'.repeat(129))).toBeUndefined();
  });
});
