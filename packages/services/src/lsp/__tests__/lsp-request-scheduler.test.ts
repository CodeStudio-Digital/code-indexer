import { describe, expect, it } from 'vitest';
import { LspRequestScheduler } from '../lsp-request-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('LspRequestScheduler', () => {
  it('supersedes obsolete keyed background work', async () => {
    const scheduler = new LspRequestScheduler();
    const firstStarted = deferred<void>();
    const first = scheduler.schedule({
      priority: 'background',
      key: 'hover:file.cs',
      run: async (signal) => {
        firstStarted.resolve();
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    await firstStarted.promise;

    const second = scheduler.schedule({
      priority: 'background',
      key: 'hover:file.cs',
      run: async () => 'current',
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('current');
    expect(scheduler.stats()).toMatchObject({ superseded: 1, queued: 0, inFlight: 0 });
    scheduler.dispose();
  });

  it('admits at most one background request and lets manual work use the second slot', async () => {
    const scheduler = new LspRequestScheduler();
    const backgroundGate = deferred<string>();
    const first = scheduler.schedule({
      priority: 'background',
      run: () => backgroundGate.promise,
    });
    const secondStarted = deferred<void>();
    const second = scheduler.schedule({
      priority: 'background',
      run: async () => { secondStarted.resolve(); return 'background-2'; },
    });
    const manual = scheduler.schedule({ priority: 'manual', run: async () => 'manual' });

    await expect(manual).resolves.toBe('manual');
    expect(scheduler.stats().backgroundInFlight).toBe(1);
    backgroundGate.resolve('background-1');
    await expect(first).resolves.toBe('background-1');
    await secondStarted.promise;
    await expect(second).resolves.toBe('background-2');
    scheduler.dispose();
  });
});
