import { describe, it, expect } from 'vitest';
import { createBus, setBusRunner, markEnded } from '@apps/http-api/coder-bus.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';

/**
 * Minimal stand-in for CoderRunner — the bus only needs an object reference,
 * never invokes runner methods. Casting through `unknown` keeps the test
 * focused on the bus-side contract.
 */
const fakeRunner = {} as unknown as CoderRunner;

describe('coder bus runner readiness', () => {
  it('runnerReady resolves once setBusRunner is called', async () => {
    const bus = createBus(new AbortController());
    let resolved: CoderRunner | null = null;
    bus.runnerReady.then((r) => { resolved = r; });

    // Microtask order: nothing has resolved yet.
    await Promise.resolve();
    expect(resolved).toBeNull();

    setBusRunner(bus, fakeRunner);
    await bus.runnerReady;
    expect(resolved).toBe(fakeRunner);
    expect(bus.runner).toBe(fakeRunner);
  });

  it('setBusRunner is idempotent — second call is a no-op', () => {
    const bus = createBus(new AbortController());
    const other = {} as unknown as CoderRunner;
    setBusRunner(bus, fakeRunner);
    setBusRunner(bus, other);
    expect(bus.runner).toBe(fakeRunner);
  });

  it('markEnded rejects runnerReady when no runner was ever attached', async () => {
    const bus = createBus(new AbortController());
    markEnded(bus, 'error', { message: 'boom' });
    let caught: unknown = null;
    try {
      await bus.runnerReady;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/before runner was attached/);
    expect(bus.ended).toBe(true);
  });

  it('markEnded leaves runnerReady resolved when runner was attached', async () => {
    const bus = createBus(new AbortController());
    setBusRunner(bus, fakeRunner);
    markEnded(bus, 'done', { reason: 'completed' });
    await expect(bus.runnerReady).resolves.toBe(fakeRunner);
  });
});
