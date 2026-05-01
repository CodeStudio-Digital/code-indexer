import { describe, it, expect, vi } from 'vitest';
import { NodeOnlyScaffolder } from '../core/sandbox/scaffolders/node-only-scaffolder.js';
import { getScaffolder } from '../core/sandbox/scaffolders/registry.js';
import type { ISandboxDriver } from '../core/sandbox/ports/sandbox-driver.js';
import type { SandboxEvent } from '../core/sandbox/types.js';

function buildCtx() {
  const events: SandboxEvent[] = [];
  return {
    events,
    ctx: {
      sandboxId: 'ds-session-99',
      containerId: 'fake-container',
      workdir: '/app',
      devServerPort: 5173,
      previewUrl: '/preview/99/',
      previewPathPrefix: '/preview/99/',
      driver: {} as unknown as ISandboxDriver,
      emit: (e: SandboxEvent) => { events.push(e); },
    },
  };
}

describe('NodeOnlyScaffolder', () => {
  it('exposes stack="node-only"', () => {
    expect(new NodeOnlyScaffolder().stack).toBe('node-only');
  });

  it('runs no I/O — never touches the driver', async () => {
    const driverSpy = {
      exec: vi.fn(),
      run: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
    } as unknown as ISandboxDriver;
    const events: SandboxEvent[] = [];
    await new NodeOnlyScaffolder().scaffold({
      sandboxId: 'x',
      containerId: 'c',
      workdir: '/app',
      devServerPort: 5173,
      previewUrl: '/preview/x/',
      previewPathPrefix: '/preview/x/',
      driver: driverSpy,
      emit: (e) => { events.push(e); },
    });
    // The whole point is NO scaffolding — no `npm create vite`, no install,
    // no dev server spawn. If any of these get called, we're back to the
    // bug where the Vite scaffold polluted the virtual project root.
    expect((driverSpy.exec as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect((driverSpy.run as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    expect((driverSpy.writeFile as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('emits a single ready step so the manager flips status to ready', async () => {
    const { ctx, events } = buildCtx();
    await new NodeOnlyScaffolder().scaffold(ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'step',
      step: 'ready',
      sandboxId: 'ds-session-99',
    });
  });

  it('is registered in the scaffolder registry under stack="node-only"', () => {
    const sf = getScaffolder('node-only');
    expect(sf).toBeInstanceOf(NodeOnlyScaffolder);
    expect(sf.stack).toBe('node-only');
  });
});
