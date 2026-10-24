import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PreviewWindow } from '../cdp.js';
import { runPreviewDispatch } from '../dispatch-scope.js';

class FakeDebugger extends EventEmitter {
  attached = false;
  attach = vi.fn(() => { this.attached = true; });
  detach = vi.fn(() => { this.attached = false; });
  isAttached = vi.fn(() => this.attached);
  sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}));
}

function fixture(): { debuggerApi: FakeDebugger; win: BrowserWindow } {
  const debuggerApi = new FakeDebugger();
  let destroyed = false;
  const win = {
    id: 17,
    close: vi.fn(),
    destroy: vi.fn(() => { destroyed = true; }),
    isDestroyed: () => destroyed,
    webContents: {
      debugger: debuggerApi,
      getURL: () => 'http://localhost:5173',
    },
  } as unknown as BrowserWindow;
  return { debuggerApi, win };
}

describe('PreviewWindow CDP capture', () => {
  it('fences a later CDP effect when authority is lost during an awaited command', async () => {
    const { debuggerApi, win } = fixture();
    const preview = await PreviewWindow.create(win, 'http://localhost:5173');
    debuggerApi.sendCommand.mockClear();
    let active = true;
    await expect(runPreviewDispatch({ signal: new AbortController().signal, assertDispatch() {
      if (!active) throw new Error('authority revoked');
    } }, async () => {
      await preview.send('Input.dispatchMouseEvent', { type: 'mousePressed' });
      active = false;
      await preview.send('Input.dispatchMouseEvent', { type: 'mouseReleased' });
    })).rejects.toThrow('authority revoked');
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(1);
    preview.close();
  });

  it('navigates while document-dependent CDP domains are still initializing', async () => {
    const { debuggerApi, win } = fixture();
    let releaseCss: (() => void) | undefined;
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'CSS.enable') {
        await new Promise<void>((resolve) => { releaseCss = resolve; });
      }
      return {};
    });

    const navigate = vi.fn(async () => {
      expect(releaseCss).toBeTypeOf('function');
      releaseCss?.();
    });
    const preview = await PreviewWindow.create(win, 'http://localhost:5173', navigate);

    expect(navigate).toHaveBeenCalledOnce();
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith('CSS.enable', {});
    preview.close();
  });

  it('fails initialization when a required CDP domain cannot be enabled', async () => {
    const { debuggerApi, win } = fixture();
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Network.enable') throw new Error('domain unavailable');
      return {};
    });

    await expect(PreviewWindow.create(win, 'http://localhost:5173')).rejects.toThrow(/Failed to initialize Preview DevTools/);
    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it('normalizes warnings and only wakes network waiters after completion', async () => {
    const { debuggerApi, win } = fixture();
    const preview = await PreviewWindow.create(win, 'http://localhost:5173');

    debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'careful' }],
    });
    expect(preview.getConsole('warn')).toHaveLength(1);
    expect(preview.getConsole('warning')[0]?.text).toBe('careful');

    let settled = false;
    const waiting = preview.waitFor('network', () => true, 500).then(() => { settled = true; });
    debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'http://localhost:5173/api/data', method: 'GET' },
      timestamp: 1,
      wallTime: 10,
      type: 'Fetch',
    });
    debuggerApi.emit('message', {}, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, statusText: 'OK', mimeType: 'application/json' },
      type: 'Fetch',
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    debuggerApi.emit('message', {}, 'Network.loadingFinished', {
      requestId: 'r1',
      timestamp: 1.25,
      encodedDataLength: 123,
    });
    await waiting;

    expect(preview.getNetwork()).toEqual([
      expect.objectContaining({ completed: true, durationMs: 250, encodedDataLength: 123 }),
    ]);
    expect(preview.getNetwork()[0]).not.toHaveProperty('startedMonotonic');
    preview.close();
  });
});
