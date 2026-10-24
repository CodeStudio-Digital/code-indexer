import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
const originalWindow = runtime.window;

afterEach(() => {
  if (originalWindow) runtime.window = originalWindow;
  else Reflect.deleteProperty(runtime, 'window');
  vi.resetModules();
});

describe('apiStream Electron context bridge', () => {
  it('restores AsyncIterable after the serializable iterator crosses preload', async () => {
    const task = { taskId: 'task-1', projectId: 7 };
    const next = vi.fn()
      .mockResolvedValueOnce({ value: [task], done: false })
      .mockResolvedValueOnce({ value: undefined, done: true });
    const close = vi.fn().mockResolvedValue({ value: undefined, done: true });
    const openStream = vi.fn(() => ({ next, return: close }));
    runtime.window = {
      electronAPI: { openStream },
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: vi.fn(() => null),
        length: 0,
      },
    } as unknown as Window & typeof globalThis;

    const { apiStream } = await import('../api-client.js');
    const stream = apiStream<Array<typeof task>>('runner.events', {});
    const iterator = stream[Symbol.asyncIterator]();

    expect(openStream).toHaveBeenCalledWith('runner.events', {});
    await expect(iterator.next()).resolves.toEqual({ value: [task], done: false });
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    expect(close).toHaveBeenCalledOnce();
  });
});
