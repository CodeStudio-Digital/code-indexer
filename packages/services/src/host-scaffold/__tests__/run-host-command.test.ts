/**
 * Regression — `runHostCommand` must resolve even when the child's `'close'`
 * event never fires. On Windows a child can exit while an inherited stdio pipe
 * stays open, so `'close'` never arrives; the previous implementation (settle
 * only in the `'close'` handler) hung forever — even past the timeout —
 * freezing the New Project wizard on its spinner. We now settle on `'exit'`
 * too, after a brief drain grace, and the timeout/abort path resolves reliably.
 *
 * The `spawnFn` seam lets us drive a fake child deterministically with fake
 * timers — no real process, no platform dependence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runHostCommand, EXIT_DRAIN_MS } from '../run-host-command.js';

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

const baseInput = { program: 'npm', args: ['install'], cwd: '/tmp/x', timeoutMs: 10_000 };
const spawnTo = (child: FakeChild) => (() => child) as unknown as typeof spawn;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('runHostCommand — exit fallback when close never fires', () => {
  it('resolves on exit (no close) after the drain grace', async () => {
    const child = new FakeChild();
    const p = runHostCommand(baseInput, spawnTo(child));
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS + 10);
    await expect(p).resolves.toEqual({ ok: true, exitCode: 0, stderrTail: '' });
  });

  it('captures trailing stdout emitted within the grace window', async () => {
    const logs: string[] = [];
    const child = new FakeChild();
    const p = runHostCommand(
      { ...baseInput, onLog: (_s, chunk) => logs.push(chunk) },
      spawnTo(child),
    );
    child.emit('exit', 0);
    child.stdout.emit('data', 'added 68 packages in 11s\n'); // arrives after exit, before grace
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS + 10);
    await p;
    expect(logs.join('')).toContain('added 68 packages');
  });

  it('prefers close (full stderr drain) when it arrives after exit', async () => {
    const child = new FakeChild();
    const p = runHostCommand(baseInput, spawnTo(child));
    child.emit('exit', 1);
    child.stderr.emit('data', 'ENOENT details');
    child.emit('close', 1); // full drain wins before the grace elapses
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.stderrTail).toContain('ENOENT details');
  });

  it('resolves the timeout path via the exit fallback instead of hanging', async () => {
    const child = new FakeChild();
    const p = runHostCommand({ ...baseInput, timeoutMs: 1_000 }, spawnTo(child));
    await vi.advanceTimersByTimeAsync(1_000); // fire the timeout → kill(child)
    expect(child.kill).toHaveBeenCalled();
    child.emit('exit', null); // killed child exits; `close` never comes
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS + 10);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
    expect(r.stderrTail).toContain('Timed out');
  });
});
