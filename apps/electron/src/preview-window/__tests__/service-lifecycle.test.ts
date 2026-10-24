import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { PreviewWindow } from '../cdp.js';
import type { RunnerBridge } from '../dev-server-resolver.js';

const harness = vi.hoisted(() => ({ create: vi.fn(), windows: [] as Array<{ destroyed: boolean }>, clearStorage: vi.fn(async () => undefined) }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    id = harness.windows.length + 1;
    destroyed = false;
    url = '';
    webContents = { session: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), on: vi.fn() },
      getURL: () => this.url, setWindowOpenHandler: vi.fn(), on: vi.fn(), stop: vi.fn() };
    constructor() { harness.windows.push(this); }
    on = vi.fn();
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    close() { this.destroy(); }
    async loadURL(url: string) { this.url = url; }
  },
  session: { fromPartition: () => ({ clearStorageData: harness.clearStorage }) },
}));
vi.mock('../cdp.js', () => ({ PreviewWindow: { create: harness.create }, DEFAULT_VIEWPORT: { width: 800, height: 600 } }));
vi.mock('../viewport.js', () => ({ resolveViewport: (_args: unknown, current: unknown) => current,
  clampToScreen: (width: number, height: number) => ({ width, height }),
  applyViewport: (_window: unknown, viewport: unknown) => viewport, VIEWPORT_PRESETS: {} }));
vi.mock('../../app-icon.js', () => ({ resolveAppIconPath: () => undefined }));
import { PreviewWindowService } from '../service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function preview(win: BrowserWindow, url: string): PreviewWindow {
  return { id: win.id, win, url, close: vi.fn(() => win.close()), clearBuffers: vi.fn(), viewport: { width: 800, height: 600 } } as unknown as PreviewWindow;
}
const services: PreviewWindowService[] = [];
function service(bridge?: RunnerBridge) { const value = new PreviewWindowService(bridge); services.push(value); return value; }
const request = (key = 'coder-1', requestId = key) => ({ key, requestId, method: 'open' as const, args: { url: 'http://localhost:5173' } });
async function until(check: () => boolean) { await vi.waitFor(() => expect(check()).toBe(true)); }
beforeEach(() => {
  harness.windows.length = 0; harness.create.mockReset(); harness.clearStorage.mockClear();
  harness.create.mockImplementation(async (win: BrowserWindow, url: string, navigate: () => Promise<void>) => {
    await navigate(); return preview(win, url);
  });
});
afterEach(async () => { await Promise.allSettled(services.splice(0).map(value => value.closeAll())); });

describe('preview physical operation lifecycle', () => {
  it('attempts all window cleanups even when one destruction fails', async () => {
    const value = service();
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string) => ({
      ...preview(win, url), close() { throw new Error('window destruction failed'); },
    }));
    await value.invoke(request('one')); await value.invoke(request('two'));
    await expect(value.closeAll()).rejects.toThrow('cleanup is unconfirmed');
    expect(harness.windows.map(win => win.destroyed)).toEqual([false, true]);
  });

  it('rejects a foreign opaque owner and legacy-prefix cleanup of a native window', async () => {
    const value = service(), key = 'coder-s-attempt-a', owner = {};
    const scope = { owner, signal: new AbortController().signal, assertDispatch() {} };
    await value.invoke(request(key), scope);
    await expect(value.invoke({ key, method: 'close' })).rejects.toThrow('different host owner');
    await expect(value.invoke({ key, method: 'close' }, { ...scope, owner: {} })).rejects.toThrow('different host owner');
    await expect(value.invoke({ key: 'coder-s', method: 'closeSessionPrefix' })).rejects.toThrow('legacy prefix');
    await expect(value.closeOwnedScope(key, {})).rejects.toThrow('different host owner');
    expect(harness.windows[0].destroyed).toBe(false);
    await value.closeOwnedScope(key, owner);
    expect(harness.windows[0].destroyed).toBe(true);
  });

  it('revalidates authority after waiting behind another operation', async () => {
    const value = service(), setup = deferred<void>();
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string) => {
      await setup.promise; return preview(win, url);
    });
    const first = value.invoke(request('one', 'first'));
    await until(() => harness.create.mock.calls.length === 1);
    let active = true;
    const queued = value.invoke(request('one', 'queued'), { signal: new AbortController().signal,
      assertDispatch() { if (!active) throw new Error('revoked'); } });
    const rejected = expect(queued).rejects.toThrow('revoked');
    active = false; setup.resolve(); await first; await rejected;
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it('waits for late CDP setup and closes the cancelled window before shutdown resolves', async () => {
    const value = service(), setup = deferred<void>();
    let created!: PreviewWindow;
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string, navigate: () => Promise<void>) => {
      await navigate(); await setup.promise; return created = preview(win, url);
    });
    const opening = value.invoke(request());
    const rejected = expect(opening).rejects.toThrow(/aborted/);
    await until(() => harness.create.mock.calls.length === 1);
    let stopped = false;
    const closed = value.closeAll().then(() => { stopped = true; });
    await expect(value.invoke(request('other'))).rejects.toThrow('closing');
    expect(stopped).toBe(false);
    setup.resolve(); await rejected; await closed;
    expect(created.close).toHaveBeenCalledTimes(1);
    expect(harness.windows[0].destroyed).toBe(true);
  });

  it('serializes one window while allowing other keys to open', async () => {
    const value = service(), setup = deferred<void>();
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string, navigate: () => Promise<void>) => {
      await navigate(); await setup.promise; return preview(win, url);
    });
    const first = value.invoke(request('coder-1', 'first'));
    await until(() => harness.create.mock.calls.length === 1);
    const queued = value.invoke(request('coder-1', 'next'));
    await value.invoke(request('coder-2'));
    expect(harness.windows).toHaveLength(2);
    setup.resolve(); await first; await queued;
    expect(harness.windows).toHaveLength(2);
  });

  it('cancels a queued request without destroying the active window', async () => {
    const value = service(), setup = deferred<void>();
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string) => {
      await setup.promise; return preview(win, url);
    });
    const first = value.invoke(request('coder-1', 'first'));
    await until(() => harness.create.mock.calls.length === 1);
    const queued = value.invoke(request('coder-1', 'queued'));
    const rejected = expect(queued).rejects.toThrow(/aborted/);
    value.cancel('queued'); setup.resolve();
    await first; await rejected;
    expect(harness.windows[0].destroyed).toBe(false);
    expect(harness.windows).toHaveLength(1);
  });

  it('rejects duplicate IDs without replacing cancellation ownership', async () => {
    const value = service(), setup = deferred<void>();
    harness.create.mockImplementationOnce(async (win: BrowserWindow, url: string) => {
      await setup.promise; return preview(win, url);
    });
    const first = value.invoke(request('coder-1', 'same'));
    const rejected = expect(first).rejects.toThrow(/aborted/);
    await until(() => harness.create.mock.calls.length === 1);
    await expect(value.invoke(request('coder-2', 'same'))).rejects.toThrow('Duplicate');
    value.cancel('same'); setup.resolve(); await rejected;
    expect(harness.windows[0].destroyed).toBe(true);
  });

  it('does not close another session whose ID shares a prefix', async () => {
    const value = service();
    await value.invoke(request('coder-1')); await value.invoke(request('coder-10'));
    await value.invoke({ key: 'coder-1', method: 'closeSessionPrefix' });
    expect(harness.windows.map(win => win.destroyed)).toEqual([true, false]);
  });

  it('preserves preview server ownership after window close and a failed stop', async () => {
    const stop = vi.fn(async () => undefined);
    const bridge: RunnerBridge = { list: () => [], pinnedPort: () => 5173,
      detectDevCommand: async () => null,
      start: async () => ({ taskId: 'owned', terminalId: 'terminal', projectId: 1, status: 'running', command: 'npm run dev', label: 'dev' }),
      stop, readBuffer: () => [{ type: 'data', data: 'Local: http://localhost:5173' }] };
    const value = service(bridge);
    await value.invoke({ key: 'coder-1', method: 'open', args: { projectId: 1 } });
    await value.invoke({ key: 'coder-1', method: 'closeWindow' });
    expect(stop).not.toHaveBeenCalled();
    stop.mockRejectedValueOnce(new Error('stop ACK lost'));
    await expect(value.closeSession('coder-1')).rejects.toThrow('ACK lost');
    await value.closeSession('coder-1');
    expect(stop.mock.calls).toEqual([['owned'], ['owned']]);
  });
});
