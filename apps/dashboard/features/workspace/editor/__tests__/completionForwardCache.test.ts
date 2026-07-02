import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordShownCompletion, tryForwardCompletion, invalidateForwardCompletion,
  __resetForwardCacheForTests,
} from '../completionForwardCache.js';

const KEY = '1:src/a.php';

beforeEach(() => {
  __resetForwardCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('client forward cache', () => {
  it('serves the remainder as the user types through the shown text', () => {
    recordShownCompletion(KEY, 10, 5, 'return $x;', 'req-1');
    const hit = tryForwardCompletion(KEY, 10, 9, (fromCol) => {
      expect(fromCol).toBe(5);
      return 'retu';
    });
    expect(hit).toEqual({ text: 'rn $x;', requestId: 'req-1' });
  });

  it('misses on divergent typing, other lines/files, or backspace', () => {
    recordShownCompletion(KEY, 10, 5, 'return $x;', 'req-1');
    expect(tryForwardCompletion(KEY, 10, 9, () => 'xxxx')).toBeNull();
    expect(tryForwardCompletion(KEY, 11, 9, () => 'retu')).toBeNull();
    expect(tryForwardCompletion('1:other.php', 10, 9, () => 'retu')).toBeNull();
    expect(tryForwardCompletion(KEY, 10, 4, () => '')).toBeNull(); // col went backwards
    expect(tryForwardCompletion(KEY, 10, 5, () => '')).toBeNull(); // nothing typed
  });

  it('misses when the whole completion was consumed', () => {
    recordShownCompletion(KEY, 10, 5, 'ab', 'req-1');
    expect(tryForwardCompletion(KEY, 10, 7, () => 'ab')).toBeNull();
  });

  it('expires by TTL and honors explicit invalidation', () => {
    vi.useFakeTimers();
    recordShownCompletion(KEY, 10, 5, 'return;', 'req-1');
    vi.advanceTimersByTime(31_000);
    expect(tryForwardCompletion(KEY, 10, 7, () => 're')).toBeNull();

    recordShownCompletion(KEY, 10, 5, 'return;', 'req-2');
    invalidateForwardCompletion(KEY);
    expect(tryForwardCompletion(KEY, 10, 7, () => 're')).toBeNull();
  });

  it('a re-shown remainder keeps serving deeper forward hits', () => {
    recordShownCompletion(KEY, 10, 5, 'return $x;', 'req-1');
    const first = tryForwardCompletion(KEY, 10, 8, () => 'ret')!;
    recordShownCompletion(KEY, 10, 8, first.text, first.requestId);
    const second = tryForwardCompletion(KEY, 10, 12, () => 'urn ')!;
    expect(second).toEqual({ text: '$x;', requestId: 'req-1' });
  });
});
