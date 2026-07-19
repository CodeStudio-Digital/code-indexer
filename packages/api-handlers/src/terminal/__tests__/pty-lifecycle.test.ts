import { describe, expect, it, vi } from 'vitest';
import { PtyManager, type IPty } from '../pty-manager.js';

function fakePty(pid = -1): IPty {
  return {
    pid,
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: vi.fn() }),
    onExit: () => ({ dispose: vi.fn() }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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
});
