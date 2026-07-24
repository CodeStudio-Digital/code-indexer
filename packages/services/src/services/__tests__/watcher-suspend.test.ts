/**
 * Bulk-op suppression state machine of FileWatcherService (suspend/resume +
 * buffer/flush semantics). Drives the extracted `noteChange` seam directly —
 * no chokidar handle is armed, so the suite is timing-tolerant and ABI-free.
 */
import { describe, it, expect, vi } from 'vitest';
import { FileWatcherService, type WatcherFileEvent } from '../watcher.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Internals = {
  pendingChanges: Map<number, Map<string, { kind: WatcherFileEvent['kind']; isDir: boolean }>>;
  events: Map<number, { onFileChanged: (events: WatcherFileEvent[]) => void | Promise<void> }>;
  noteChange: (
    projectId: number, filePath: string, kind: WatcherFileEvent['kind'],
    isDir: boolean, debounceMs: number,
  ) => void;
};

/** Arm the per-project buffers exactly like armFileWatcher does, sans chokidar. */
function armed(): { svc: FileWatcherService; internals: Internals; batches: WatcherFileEvent[][] } {
  const svc = new FileWatcherService();
  const internals = svc as unknown as Internals;
  const batches: WatcherFileEvent[][] = [];
  internals.pendingChanges.set(1, new Map());
  internals.events.set(1, { onFileChanged: (events) => { batches.push(events); } });
  return { svc, internals, batches };
}

describe('FileWatcherService bulk-op suppression', () => {
  it('delivers a debounced batch in the normal (non-suspended) flow', async () => {
    const { internals, batches } = armed();
    internals.noteChange(1, 'D:/p/a.ts', 'upsert', false, 10);
    internals.noteChange(1, 'D:/p/b.ts', 'delete', false, 10);
    await sleep(40);
    expect(batches).toEqual([[
      { path: 'D:/p/a.ts', kind: 'upsert', isDir: false },
      { path: 'D:/p/b.ts', kind: 'delete', isDir: false },
    ]]);
  });

  it('requeues a failed debounced batch and retries without an unhandled rejection', async () => {
    const { internals, batches } = armed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let attempts = 0;
      internals.events.set(1, {
        onFileChanged: (events) => {
          attempts++;
          if (attempts === 1) throw new Error('SQLITE_BUSY');
          batches.push(events);
        },
      });

      internals.noteChange(1, 'D:/p/retry.ts', 'upsert', false, 1);

      await vi.waitFor(() => expect(attempts).toBe(2), { timeout: 1_000 });
      expect(batches).toEqual([[
        { path: 'D:/p/retry.ts', kind: 'upsert', isDir: false },
      ]]);
      expect(internals.pendingChanges.get(1)?.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('suspend discards the buffered burst and cancels the pending flush', async () => {
    const { svc, internals, batches } = armed();
    internals.noteChange(1, 'D:/p/burst-1.ts', 'upsert', false, 10);
    internals.noteChange(1, 'D:/p/burst-2.ts', 'upsert', false, 10);
    svc.suspend(1);
    await sleep(40); // well past the debounce — nothing may fire
    expect(batches).toEqual([]);
    expect(internals.pendingChanges.get(1)?.size).toBe(0);
  });

  it('while suspended, events coalesce without arming a timer; the barrier flush still delivers them', async () => {
    const { svc, internals, batches } = armed();
    svc.suspend(1);
    internals.noteChange(1, 'D:/p/mid-scan.ts', 'upsert', false, 10);
    await sleep(40);
    expect(batches).toEqual([]); // no debounce flush while suspended
    await svc.flushPending(1); // the reconcile's scan barrier
    expect(batches).toEqual([[{ path: 'D:/p/mid-scan.ts', kind: 'upsert', isDir: false }]]);
  });

  it('resume delivers the remainder buffered during suspension', async () => {
    const { svc, internals, batches } = armed();
    svc.suspend(1);
    internals.noteChange(1, 'D:/p/tail.ts', 'upsert', false, 10);
    svc.resume(1);
    await sleep(10);
    expect(batches).toEqual([[{ path: 'D:/p/tail.ts', kind: 'upsert', isDir: false }]]);
    // resume on a non-suspended project is a no-op (no double delivery).
    svc.resume(1);
    await sleep(10);
    expect(batches).toHaveLength(1);
  });

  it('stopWatching clears suspension state; stopAll sweeps suspended-only projects', async () => {
    const { svc, internals, batches } = armed();
    svc.suspend(1);
    internals.noteChange(1, 'D:/p/gone.ts', 'upsert', false, 10);
    await svc.stopWatching(1);
    svc.resume(1); // must be a no-op — suspension was cleared with the stop
    await sleep(10);
    expect(batches).toEqual([]);

    // A project suspended before any watcher was armed is still swept.
    const bare = new FileWatcherService();
    bare.suspend(7);
    await bare.stopAll();
    expect(bare.isWatching(7)).toBe(false);
  });
});
