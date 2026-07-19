import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { killTreeMock, killProcessTreesSyncMock } = vi.hoisted(() => ({
  killTreeMock: vi.fn(() => Promise.resolve()),
  killProcessTreesSyncMock: vi.fn(),
}));

vi.mock('../tree-kill.js', () => ({ killTree: killTreeMock }));
vi.mock('@mcp/shared/utils/process-tree.js', () => ({
  killProcessTreesSync: killProcessTreesSyncMock,
}));

import { childRegistry } from '../child-process-registry.js';

// Entries carry no `pid`, so the registry's force tree-kill (taskkill /
// process.kill) is a no-op — these tests exercise the bookkeeping + ordering
// only, never a real OS signal.
beforeEach(() => vi.clearAllMocks());
afterEach(() => childRegistry.killAllSync());

describe('ChildProcessRegistry', () => {
  it('registers and unregisters by handle', () => {
    const unreg = childRegistry.register({ kind: 'server', label: 'unreg-me', kill: () => undefined });
    expect(childRegistry.list().some((c) => c.label === 'unreg-me')).toBe(true);
    unreg();
    expect(childRegistry.list().some((c) => c.label === 'unreg-me')).toBe(false);
  });

  it('killAll gracefully kills every child (force=false) then clears', async () => {
    const seen: Array<[string, boolean]> = [];
    childRegistry.register({ kind: 'pty', label: 'a', kill: (f) => { seen.push(['a', f]); } });
    childRegistry.register({ kind: 'pty', label: 'b', kill: (f) => { seen.push(['b', f]); } });
    await childRegistry.killAll({ graceMs: 50 });
    expect(seen).toContainEqual(['a', false]);
    expect(seen).toContainEqual(['b', false]);
    expect(childRegistry.list()).toHaveLength(0);
  });

  it('killAll awaits the asynchronous tree-kill queue', async () => {
    childRegistry.register({ pid: 51_001, kind: 'process', label: 'tree', kill: () => undefined });

    await childRegistry.killAll({ graceMs: 50 });

    expect(killTreeMock).toHaveBeenCalledWith(51_001);
  });

  it('killAll is bounded by graceMs and tolerates a throwing/hanging kill', async () => {
    let cleanRan = false;
    childRegistry.register({ kind: 'pty', label: 'throws', kill: () => { throw new Error('boom'); } });
    childRegistry.register({ kind: 'pty', label: 'hangs', kill: () => new Promise<void>(() => {}) });
    childRegistry.register({ kind: 'pty', label: 'clean', kill: () => { cleanRan = true; } });
    await childRegistry.killAll({ graceMs: 30 });
    expect(cleanRan).toBe(true);
    expect(childRegistry.list()).toHaveLength(0);
  });

  it('killAllSync fires kill(force=true) and clears synchronously', () => {
    let forced: boolean | null = null;
    childRegistry.register({ pid: 51_002, kind: 'pty', label: 's', kill: (f) => { forced = f; } });
    childRegistry.killAllSync();
    expect(forced).toBe(true);
    expect(killProcessTreesSyncMock).toHaveBeenCalledWith([51_002]);
    expect(childRegistry.list()).toHaveLength(0);
  });
});
