/**
 * Unit tests for the RecentMessageKeys idempotency store + normalizeDedupeKey.
 * Pure/in-memory — no route mount, no ABI, no fake timers (TTL uses an injected
 * clock).
 */
import { describe, it, expect } from 'vitest';
import { RecentMessageKeys, normalizeDedupeKey } from '../recent-message-keys.js';

// Minimal structural bus — the store only holds a WeakRef and never reads it.
function fakeBus(id: string): { busId: string; ended: boolean } {
  return { busId: id, ended: false };
}

describe('RecentMessageKeys', () => {
  it('returns the recorded bus + sinceHint on a lookup hit', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    const bus = fakeBus('a');
    store.record(1, 'k', bus, 7);
    expect(store.lookup(1, 'k')).toEqual({ bus, sinceHint: 7 });
  });

  it('misses on an unknown key or session', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    store.record(1, 'k', fakeBus('a'), 0);
    expect(store.lookup(1, 'other')).toBeUndefined();
    expect(store.lookup(2, 'k')).toBeUndefined();
  });

  it('isolates identical keys across sessions', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>();
    const b1 = fakeBus('a');
    const b2 = fakeBus('b');
    store.record(1, 'k', b1, 1);
    store.record(2, 'k', b2, 2);
    expect(store.lookup(1, 'k')?.bus).toBe(b1);
    expect(store.lookup(2, 'k')?.bus).toBe(b2);
  });

  it('expires entries past the TTL (injected clock)', () => {
    let now = 1000;
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ ttlMs: 100, now: () => now });
    store.record(1, 'k', fakeBus('a'), 0);
    now = 1099;
    expect(store.lookup(1, 'k')).toBeDefined();
    now = 1101;
    expect(store.lookup(1, 'k')).toBeUndefined();
  });

  it('evicts the oldest key once the per-session cap is exceeded (LRU)', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    store.record(1, 'a', fakeBus('a'), 0);
    store.record(1, 'b', fakeBus('b'), 0);
    store.record(1, 'c', fakeBus('c'), 0); // evicts 'a'
    expect(store.lookup(1, 'a')).toBeUndefined();
    expect(store.lookup(1, 'b')).toBeDefined();
    expect(store.lookup(1, 'c')).toBeDefined();
  });

  it('re-recording a key refreshes its LRU position', () => {
    const store = new RecentMessageKeys<{ busId: string; ended: boolean }>({ maxPerSession: 2 });
    store.record(1, 'a', fakeBus('a'), 0);
    store.record(1, 'b', fakeBus('b'), 0);
    store.record(1, 'a', fakeBus('a2'), 0); // 'a' back to MRU
    store.record(1, 'c', fakeBus('c'), 0); // evicts 'b' (now oldest), not 'a'
    expect(store.lookup(1, 'a')).toBeDefined();
    expect(store.lookup(1, 'b')).toBeUndefined();
    expect(store.lookup(1, 'c')).toBeDefined();
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
