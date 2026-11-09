import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { bindRendererLifetime, raceWithAbort } from '../invoke-lifecycle.js';

describe('renderer request lifetime', () => {
  it('keeps runner events alive across project/hash/history navigation', async () => {
    const sender = new EventEmitter();
    const controller = new AbortController();
    bindRendererLifetime(sender as WebContents, (reason) => controller.abort(new Error(reason)));
    let publish!: (snapshot: string[]) => void;
    const next = raceWithAbort(controller.signal, () => new Promise<string[]>(resolve => { publish = resolve; }));
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    // Older Electron event signature also reports hash routing as in-place.
    sender.emit('did-start-navigation', {}, 'file:///app.html#/projects/7', true, true);
    sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(controller.signal.aborted).toBe(false);
    publish(['npm run dev']);
    await expect(next).resolves.toEqual(['npm run dev']);
  });

  it.each(['navigation', 'legacy navigation', 'render-process-gone', 'destroyed'])(
    'still cancels pending work on %s', async (event) => {
      const sender = new EventEmitter();
      const controller = new AbortController();
      bindRendererLifetime(sender as WebContents, reason => controller.abort(new Error(reason)));
      const next = raceWithAbort(controller.signal, () => new Promise(() => {}));
      const rejected = expect(next).rejects.toThrow('renderer');
      if (event === 'navigation') sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      else if (event === 'legacy navigation') sender.emit('did-start-navigation', {}, 'file:///app.html', false, true);
      else sender.emit(event);
      await rejected;
    },
  );
});

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
