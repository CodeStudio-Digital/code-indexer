import { describe, it, expect, afterEach } from 'vitest';
import { childRegistry } from '../child-process-registry.js';

// Entries carry no `pid`, so the registry's force tree-kill (taskkill /
// process.kill) is a no-op — these tests exercise the bookkeeping + ordering
// only, never a real OS signal.
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
    childRegistry.register({ kind: 'pty', label: 's', kill: (f) => { forced = f; } });
    childRegistry.killAllSync();
    expect(forced).toBe(true);
    expect(childRegistry.list()).toHaveLength(0);
  });
});
