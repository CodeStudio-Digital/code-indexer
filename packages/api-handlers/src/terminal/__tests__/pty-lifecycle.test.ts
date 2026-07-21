import { describe, expect, it, vi } from 'vitest';
import { PtyManager, type IPty } from '../pty-manager.js';

function fakePty(pid = -1): IPty & {
  emitData(data: string): void;
  emitExit(exitCode?: number): void;
} {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  return {
    pid,
    cols: 80,
    rows: 24,
    onData: (listener) => {
      dataListener = listener;
      return { dispose: vi.fn() };
    },
    onExit: (listener) => {
      exitListener = listener;
      return { dispose: vi.fn() };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (data) => dataListener?.(data),
    emitExit: (exitCode = 0) => exitListener?.({ exitCode }),
  };
}

describe('PtyManager lifecycle', () => {
  it('kills an individual PTY through the manager-owned lifecycle path', () => {
    const manager = new PtyManager();
    const pty = fakePty();
    const { id } = manager.registerExternalPty(pty);

    manager.kill(id);

    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it('killAll is idempotent and clears every retained PTY entry', () => {
    const manager = new PtyManager();
    const first = fakePty();
    const second = fakePty();
    manager.registerExternalPty(first);
    manager.registerExternalPty(second);

    manager.killAll();
    manager.killAll();

    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).toHaveBeenCalledOnce();
    expect(manager.listPids()).toEqual([]);
  });

  it('keeps retained output replayable after exit until explicitly released', () => {
    vi.useFakeTimers();
    const manager = new PtyManager();
    const pty = fakePty();
    const { id } = manager.registerExternalPty(pty, { retainOnExit: true });

    pty.emitData('real runner output\r\n');
    pty.emitExit(1);
    vi.advanceTimersByTime(60_000);

    const chunks: unknown[] = [];
    manager.subscribe(id, (chunk) => chunks.push(chunk));
    expect(chunks).toEqual([
      { type: 'data', data: 'real runner output\r\n' },
      { type: 'exit', code: 1, signal: null },
    ]);

    manager.release(id);
    expect(() => manager.subscribe(id, () => undefined)).toThrow(/terminal not found/);
    vi.useRealTimers();
  });

  it('does not signal an already-exited retained PTY during global cleanup', () => {
    const manager = new PtyManager();
    const pty = fakePty(1234);
    manager.registerExternalPty(pty, { retainOnExit: true });
    pty.emitExit(0);

    manager.killAll();

    expect(pty.kill).not.toHaveBeenCalled();
    expect(manager.listPids()).toEqual([]);
  });
});
