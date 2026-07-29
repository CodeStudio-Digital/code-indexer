import { describe, it, expect, beforeEach } from 'vitest';
import {
  withSessionLock,
  _resetSessionLocksForTests,
} from '@apps/http-api/server/routes/coder/sessionLock.js';

const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';
const SESSION_FAILING = '00000000-0000-4000-8000-000000000007';
const SESSION_CONTENDED = '00000000-0000-4000-8000-000000000099';

describe('withSessionLock', () => {
  beforeEach(() => {
    _resetSessionLocksForTests();
  });

  it('serializes concurrent acquires for the same id', async () => {
    const order: string[] = [];
    const a = withSessionLock(SESSION_A, async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a:end');
      return 'A';
    });
    const b = withSessionLock(SESSION_A, async () => {
      order.push('b:start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('b:end');
      return 'B';
    });
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    // b cannot start until a finishes
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different ids concurrently', async () => {
    const order: string[] = [];
    const a = withSessionLock(SESSION_A, async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
      return 'A';
    });
    const b = withSessionLock(SESSION_B, async () => {
      order.push('b:start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('b:end');
      return 'B';
    });
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    // b is on a different id, so its start interleaves with a
    expect(order[0]).toBe('a:start');
    expect(order).toContain('b:start');
    expect(order).toContain('b:end');
  });

  it('does not poison the chain when one acquirer throws', async () => {
    const failing = withSessionLock(SESSION_FAILING, async () => {
      throw new Error('boom');
    }).catch((e) => `caught:${(e as Error).message}`);
    const after = withSessionLock(SESSION_FAILING, async () => 'ok');
    const [first, second] = await Promise.all([failing, after]);
    expect(first).toBe('caught:boom');
    expect(second).toBe('ok');
  });

  it('does not leak lock entries forever under contention', async () => {
    // Run many sequential lock acquires; the internal map should drain.
    for (let i = 0; i < 50; i++) {
      await withSessionLock(SESSION_CONTENDED, async () => i);
    }
    // After draining, a new acquire should still work and run promptly.
    const start = Date.now();
    const result = await withSessionLock(
      SESSION_CONTENDED,
      async () => 'fast',
    );
    expect(result).toBe('fast');
    expect(Date.now() - start).toBeLessThan(50);
  });
});
