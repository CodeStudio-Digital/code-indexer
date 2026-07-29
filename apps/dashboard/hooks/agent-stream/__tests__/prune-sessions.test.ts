import { describe, expect, it } from 'vitest';
import { pruneSessions, MAX_SESSIONS } from '../prune-sessions.js';
import { EMPTY_STATE, type SessionState } from '../types.js';

const sid = (id: number) =>
  `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;

/** Build a map of `count` idle sessions with deterministic UUID keys. */
function idleMap(count: number, overrides: Record<string, Partial<SessionState>> = {}) {
  const map: Record<string, SessionState> = {};
  for (let id = 1; id <= count; id++) {
    map[sid(id)] = { ...EMPTY_STATE, ...(overrides[sid(id)] ?? {}) };
  }
  return map;
}

/** Recency map where lower id = older (touched earlier). */
function touchedByAge(count: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let id = 1; id <= count; id++) m.set(sid(id), id * 1000);
  return m;
}

describe('pruneSessions', () => {
  it('is a no-op at or below the cap', () => {
    const map = idleMap(MAX_SESSIONS);
    const out = pruneSessions(map, sid(1), touchedByAge(MAX_SESSIONS));
    expect(out).toBe(map); // same reference — nothing copied
    expect(Object.keys(out)).toHaveLength(MAX_SESSIONS);
  });

  it('evicts the least-recently-touched idle sessions beyond the cap', () => {
    const over = MAX_SESSIONS + 3;
    const out = pruneSessions(idleMap(over), sid(99) /* active not present */, touchedByAge(over));
    expect(Object.keys(out)).toHaveLength(MAX_SESSIONS);
    // ids 1,2,3 are the oldest → evicted.
    expect(out[sid(1)]).toBeUndefined();
    expect(out[sid(2)]).toBeUndefined();
    expect(out[sid(3)]).toBeUndefined();
    expect(out[sid(4)]).toBeDefined();
    expect(out[sid(over)]).toBeDefined();
  });

  it('never evicts the active session even when it is the oldest', () => {
    const over = MAX_SESSIONS + 1;
    const out = pruneSessions(idleMap(over), sid(1) /* oldest is active */, touchedByAge(over));
    expect(out[sid(1)]).toBeDefined(); // protected
    expect(out[sid(2)]).toBeUndefined(); // next-oldest evicted instead
    expect(Object.keys(out)).toHaveLength(MAX_SESSIONS);
  });

  it('never evicts a session whose run is still streaming', () => {
    const over = MAX_SESSIONS + 2;
    // ids 1 and 2 are the oldest but still streaming → must survive.
    const out = pruneSessions(
      idleMap(over, {
        [sid(1)]: { streaming: true },
        [sid(2)]: { streaming: true },
      }),
      sid(999),
      touchedByAge(over),
    );
    expect(out[sid(1)]).toBeDefined();
    expect(out[sid(2)]).toBeDefined();
    // The two oldest NON-streaming sessions (3, 4) are evicted instead.
    expect(out[sid(3)]).toBeUndefined();
    expect(out[sid(4)]).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(MAX_SESSIONS);
  });

  it('keeps everything when no session is eligible for eviction', () => {
    const over = MAX_SESSIONS + 5;
    // Every session is streaming → nothing evictable, map must be preserved.
    const overrides: Record<string, Partial<SessionState>> = {};
    for (let id = 1; id <= over; id++) overrides[sid(id)] = { streaming: true };
    const out = pruneSessions(idleMap(over, overrides), sid(1), touchedByAge(over));
    expect(Object.keys(out)).toHaveLength(over);
  });

  it('trims the recency map for evicted ids', () => {
    const over = MAX_SESSIONS + 2;
    const touched = touchedByAge(over);
    pruneSessions(idleMap(over), sid(99), touched);
    expect(touched.has(sid(1))).toBe(false);
    expect(touched.has(sid(2))).toBe(false);
    expect(touched.has(sid(over))).toBe(true);
  });
});
