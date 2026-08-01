import { describe, expect, it, vi } from 'vitest';
import { raceWithAbort } from '../invoke-lifecycle.js';

describe('raceWithAbort', () => {
  it('releases the IPC-facing promise when navigation aborts an uncooperative handler', async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    const pending = raceWithAbort(controller.signal, operation);
    controller.abort(new Error('renderer navigated'));

    await expect(pending).rejects.toThrow('renderer navigated');
    expect(operation).toHaveBeenCalledOnce();

    // The detached operation remains safe to settle later.
    finish('late result');
    await Promise.resolve();
  });

  it('preserves a normal result and an already-aborted reason', async () => {
    await expect(
      raceWithAbort(new AbortController().signal, async () => 'ok'),
    ).resolves.toBe('ok');

    const controller = new AbortController();
    controller.abort(new Error('renderer closed'));
    const operation = vi.fn(async () => 'unreachable');
    await expect(
      raceWithAbort(controller.signal, operation),
    ).rejects.toThrow('renderer closed');
    expect(operation).not.toHaveBeenCalled();
  });
});
