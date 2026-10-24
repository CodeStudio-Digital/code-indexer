import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { execStream, type ExecChunk } from '../exec.js';

function pipe() {
  return Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(), pause: vi.fn(), resume: vi.fn(), destroy: vi.fn(),
  });
}

function fixture(signal?: AbortSignal) {
  const child = Object.assign(new EventEmitter(), {
    stdout: pipe(), stderr: pipe(), kill: vi.fn(),
  });
  child.kill.mockImplementation(() => { child.emit('close', null); return true; });
  mocks.spawn.mockReturnValue(child);
  const iterator = execStream({ cmd: 'node', args: [], cwd: process.cwd(), allow: ['node'], signal });
  return { child, iterator };
}

beforeEach(() => mocks.spawn.mockReset());

describe('plugin command flow control', () => {
  it('does not spawn when cancellation predates subscription', async () => {
    const controller = new AbortController();
    controller.abort();
    const { iterator } = fixture(controller.signal);
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { frames: 16, data: 'x'.repeat(64 * 1024) },
    { frames: 256, data: 'x' },
  ])('bounds queued bytes and frames, resuming both pipes after draining ($frames frames)', async ({ frames, data }) => {
    const { child, iterator } = fixture();
    const first = iterator.next();
    for (let i = 0; i < frames; i++) {
      (i % 2 ? child.stderr : child.stdout).emit('data', data);
    }
    expect(child.stdout.pause).toHaveBeenCalledOnce();
    expect(child.stderr.pause).toHaveBeenCalledOnce();
    const seen: ExecChunk[] = [(await first).value!];
    expect(child.stdout.resume).not.toHaveBeenCalled();
    for (let i = 1; i < frames / 2; i++) seen.push((await iterator.next()).value!);
    expect(child.stdout.resume).toHaveBeenCalledOnce();
    expect(child.stderr.resume).toHaveBeenCalledOnce();
    child.emit('close', 0);
    for await (const frame of iterator) seen.push(frame);
    expect(seen.filter(frame => frame.type === 'data')).toEqual(
      Array.from({ length: frames }, () => ({ type: 'data', data })),
    );
    expect(seen.at(-1)).toEqual({ type: 'exit', code: 0 });
  });

  it('kills and closes paused pipes when cancelled, preserving already queued output', async () => {
    const controller = new AbortController();
    const { child, iterator } = fixture(controller.signal);
    const first = iterator.next();
    child.stdout.emit('data', 'x'.repeat(1024 * 1024));
    expect(child.stdout.pause).toHaveBeenCalledOnce();
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect((await first).value).toMatchObject({ type: 'data' });
    expect((await iterator.next()).value).toEqual({ type: 'exit', code: null });
    expect((await iterator.next()).done).toBe(true);
  });

  it('closes pipes and detaches cancellation when the consumer returns early', async () => {
    const controller = new AbortController();
    const { child, iterator } = fixture(controller.signal);
    const first = iterator.next();
    child.stdout.emit('data', 'ready');
    await first;
    await iterator.return(undefined);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
