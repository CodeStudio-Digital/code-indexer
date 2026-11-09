import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn(), untrack: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('@mcp/shared/utils/process-tree.js', () => ({ killProcessTree: mock.killTree, trackProcessTree: () => mock.untrack }));
import { LocalShellAdapter } from '../shell-port.js';

let child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { pid: 424242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mock.spawn.mockReturnValue(child);
  mock.killTree.mockImplementation(() => new Promise<void>(() => {}));
});
afterEach(() => { vi.useRealTimers(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });

it('drains final output after exit and never times out or kills a completed launcher', async () => {
  const pending = new LocalShellAdapter().exec('fixture', { cwd: '/', timeoutMs: 1000 });
  child.stdout.write('PID receipt\n');
  child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(250);
  child.stdout.write('final buffered output\n');
  await vi.advanceTimersByTimeAsync(250);
  expect(await pending).toMatchObject({ exitCode: 0, timedOut: false, outputDrainTimedOut: true,
    stdout: 'PID receipt\nfinal buffered output\n' });
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock.killTree).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['timeout', 'abort'] as const)('settles %s cleanup before the runner backstop even if the tree killer never returns', async kind => {
  const controller = new AbortController();
  const pending = new LocalShellAdapter().exec('fixture', { cwd: '/', timeoutMs: 1000, signal: controller.signal });
  child.stdout.write('partial output');
  if (kind === 'abort') controller.abort();
  else await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(4000);
  expect(await pending).toMatchObject({ exitCode: null, timedOut: kind === 'timeout', terminationUnconfirmed: true,
    processId: 424242, stdout: 'partial output' });
  expect(mock.killTree).toHaveBeenCalledOnce(); expect(mock.untrack).not.toHaveBeenCalled();
  child.emit('exit', null); // Ownership is released only upon a real exit.
  expect(mock.untrack).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
