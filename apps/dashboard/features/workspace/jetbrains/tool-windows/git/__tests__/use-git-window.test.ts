import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitReloadCoordinator } from '../use-git-window.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createGitReloadCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of watcher refreshes behind one debounce window', async () => {
    const coordinator = createGitReloadCoordinator(100);
    const runner = vi.fn(async (_run: { silent: boolean; isCurrent(): boolean }) => {});
    coordinator.setRunner(runner);

    const first = coordinator.request({ silent: true, debounce: true });
    await vi.advanceTimersByTimeAsync(40);
    const second = coordinator.request({ silent: true, debounce: true });
    await vi.advanceTimersByTimeAsync(40);
    const third = coordinator.request({ silent: true, debounce: true });

    await vi.advanceTimersByTimeAsync(99);
    expect(runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second, third]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0].silent).toBe(true);
  });

  it('never overlaps runs and performs one current refresh after an in-flight change', async () => {
    const coordinator = createGitReloadCoordinator(100);
    const gates = [deferred(), deferred()];
    const runs: Array<{ silent: boolean; isCurrent: () => boolean }> = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;
    coordinator.setRunner(async (run) => {
      const index = runs.push(run) - 1;
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      await gates[index]!.promise;
      activeRuns -= 1;
    });

    const initial = coordinator.request();
    expect(runs).toHaveLength(1);
    const changed = coordinator.request({ silent: true, debounce: true });
    expect(runs[0]!.isCurrent()).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toHaveLength(1);
    gates[0]!.resolve();
    await flushMicrotasks();

    expect(runs).toHaveLength(2);
    expect(runs[1]!.isCurrent()).toBe(true);
    expect(maxActiveRuns).toBe(1);

    gates[1]!.resolve();
    await Promise.all([initial, changed]);
    expect(runs).toHaveLength(2);
  });

  it('lets an explicit refresh bypass and absorb a pending watcher debounce', async () => {
    const coordinator = createGitReloadCoordinator(100);
    const runner = vi.fn(async (_run: { silent: boolean; isCurrent(): boolean }) => {});
    coordinator.setRunner(runner);

    const watcher = coordinator.request({ silent: true, debounce: true });
    await vi.advanceTimersByTimeAsync(50);
    const explicit = coordinator.request();
    await Promise.all([watcher, explicit]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0].silent).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('queues an explicit refresh immediately behind an in-flight silent run', async () => {
    const coordinator = createGitReloadCoordinator(100);
    const gates = [deferred(), deferred()];
    const runs: Array<{ silent: boolean }> = [];
    coordinator.setRunner(async (run) => {
      const index = runs.push(run) - 1;
      await gates[index]!.promise;
    });

    const silent = coordinator.request({ silent: true });
    const explicit = coordinator.request();
    expect(runs.map((run) => run.silent)).toEqual([true]);

    gates[0]!.resolve();
    await flushMicrotasks();
    expect(runs.map((run) => run.silent)).toEqual([true, false]);

    gates[1]!.resolve();
    await Promise.all([silent, explicit]);
  });

  it('invalidates an old context without allowing its result to become current', async () => {
    const coordinator = createGitReloadCoordinator(100);
    const gates = [deferred(), deferred()];
    const runs: Array<{ isCurrent: () => boolean }> = [];
    coordinator.setRunner(async (run) => {
      const index = runs.push(run) - 1;
      await gates[index]!.promise;
    });

    const oldContext = coordinator.request();
    coordinator.invalidate();
    expect(runs[0]!.isCurrent()).toBe(false);
    await oldContext;

    const newContext = coordinator.request();
    expect(runs).toHaveLength(1);
    gates[0]!.resolve();
    await flushMicrotasks();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.isCurrent()).toBe(true);

    gates[1]!.resolve();
    await newContext;
  });
});
