/**
 * PR-E prerequisite: `pendingResolves` Map supports concurrent waits
 * keyed by `askId`. Without this, the budget gate's ask would clash
 * with a concurrently pending `ask_user`/`submit_plan`/`submit_tasks`.
 */
import { describe, expect, it } from 'vitest';

// We avoid importing the whole CoderRunner (which drags in providers,
// session store, skill store, etc.). Instead we re-create the minimal
// pendingResolves contract here — the production code lives in
// `runner.ts` (waitForUserInput / provideUserInput / isWaitingForInput /
// interruptWait / abort) and is exercised end-to-end in the
// `execute-tasks-budget.test.ts` integration test below this file.
//
// The contract this test pins:
//   - Two distinct askIds resolve independently.
//   - Default key + custom key coexist without interference.
//   - provideUserInput(answer, askId) only fires the matching slot.
//   - isWaitingForInput(askId) is per-key; isWaitingForInput() is "any".
//   - abort() resolves ALL pending slots with { aborted: true }.

class MiniRunner {
  private readonly DEFAULT = '__default__';
  private map = new Map<string, (v: string) => void>();
  waitForUserInput(askId?: string): Promise<string> {
    const key = askId ?? this.DEFAULT;
    return new Promise((r) => { this.map.set(key, r); });
  }
  provideUserInput(value: string, askId?: string): boolean {
    const key = askId ?? this.DEFAULT;
    const r = this.map.get(key);
    if (!r) return false;
    this.map.delete(key);
    r(value);
    return true;
  }
  isWaitingForInput(askId?: string): boolean {
    if (askId !== undefined) return this.map.has(askId);
    return this.map.size > 0;
  }
  abort(): boolean {
    if (this.map.size === 0) return false;
    const payload = JSON.stringify({ aborted: true });
    const resolvers = Array.from(this.map.values());
    this.map.clear();
    for (const r of resolvers) r(payload);
    return true;
  }
}

describe('pendingResolves concurrent waits', () => {
  it('two distinct askIds resolve independently', async () => {
    const r = new MiniRunner();
    const a = r.waitForUserInput('alpha');
    const b = r.waitForUserInput('beta');

    expect(r.isWaitingForInput('alpha')).toBe(true);
    expect(r.isWaitingForInput('beta')).toBe(true);

    r.provideUserInput('answer-A', 'alpha');
    r.provideUserInput('answer-B', 'beta');

    expect(await a).toBe('answer-A');
    expect(await b).toBe('answer-B');
  });

  it('default slot coexists with keyed slot', async () => {
    const r = new MiniRunner();
    const def = r.waitForUserInput();
    const budget = r.waitForUserInput('budget_x');

    expect(r.isWaitingForInput()).toBe(true);
    expect(r.isWaitingForInput('budget_x')).toBe(true);

    r.provideUserInput('budget answer', 'budget_x');
    expect(await budget).toBe('budget answer');
    expect(r.isWaitingForInput('budget_x')).toBe(false);
    expect(r.isWaitingForInput()).toBe(true); // default slot still pending

    r.provideUserInput('default answer');
    expect(await def).toBe('default answer');
  });

  it('provideUserInput on wrong askId is a no-op and returns false', async () => {
    const r = new MiniRunner();
    const a = r.waitForUserInput('alpha');
    let resolved = false;
    a.then(() => { resolved = true; });
    const accepted = r.provideUserInput('wrong slot', 'beta');
    expect(accepted).toBe(false);
    // Give microtasks a chance to fire — 'alpha' should still be pending.
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(r.isWaitingForInput('alpha')).toBe(true);
  });

  it('abort resolves ALL slots with { aborted: true }', async () => {
    const r = new MiniRunner();
    const a = r.waitForUserInput('alpha');
    const b = r.waitForUserInput('beta');
    const def = r.waitForUserInput();
    expect(r.abort()).toBe(true);
    expect(JSON.parse(await a)).toEqual({ aborted: true });
    expect(JSON.parse(await b)).toEqual({ aborted: true });
    expect(JSON.parse(await def)).toEqual({ aborted: true });
    expect(r.isWaitingForInput()).toBe(false);
  });

  it('re-registering the same key overwrites the prior wait (single-slot semantics)', async () => {
    const r = new MiniRunner();
    const first = r.waitForUserInput('same');
    let firstResolved = false;
    first.then(() => { firstResolved = true; });
    const second = r.waitForUserInput('same');
    r.provideUserInput('hit', 'same');
    expect(await second).toBe('hit');
    // First was overwritten — its promise will never resolve. We don't
    // crash; the system reclaims the pending closure on GC. This pin
    // documents the chosen semantics so a future "queue per key"
    // refactor stays a deliberate change.
    await Promise.resolve();
    expect(firstResolved).toBe(false);
  });
});
