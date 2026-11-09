import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiStream } from '../../../lib/api-client.js';
import { installWebviewBridge, registerPluginFrame, unregisterPluginFrame } from '../webview-bridge.js';

vi.mock('../../../lib/api-client.js', () => ({ apiCall: vi.fn(), apiStream: vi.fn() }));
vi.mock('../../../components/ui/prompt-dialog.js', () => ({ confirm: vi.fn(), prompt: vi.fn(), toast: {} }));
vi.mock('../../../i18n/index.js', () => ({ default: { t: (key: string) => key } }));

let dispose: () => void;
let host: EventTarget;
const frames: WindowProxy[] = [];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function source() {
  const frame = { postMessage: vi.fn() } as unknown as WindowProxy;
  frames.push(frame); registerPluginFrame(frame, { namespace: 'owned-plugin', projectId: 7 });
  return frame;
}
function message(frame: WindowProxy, kind = 'openStream', id = 1) {
  host.dispatchEvent(Object.assign(new Event('message'), {
    source: frame, data: { __mcpPlugin: kind, id, method: 'plugins.execStream', payload: { namespace: 'forged' } },
  }));
}
function pendingStream() {
  let next!: (step: IteratorResult<unknown>) => void;
  const iterator: AsyncIterableIterator<unknown> = {
    [Symbol.asyncIterator]() { return this; },
    next: vi.fn(() => new Promise<IteratorResult<unknown>>(resolve => { next = resolve; })),
    // Deliberately do not settle the outstanding read: the bridge must release
    // its own pump even with a legacy/uncooperative transport.
    return: vi.fn(async () => ({ value: undefined, done: true })),
  };
  return { iterator, deliver: (value: unknown) => next({ value, done: false }) };
}
beforeEach(() => {
  vi.useFakeTimers(); host = new EventTarget(); vi.stubGlobal('window', host);
  dispose = installWebviewBridge();
});
afterEach(() => {
  dispose(); frames.splice(0).forEach(unregisterPluginFrame);
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('plugin stream ownership', () => {
  it('returns an idle iterator immediately on close, once, and drops late data', async () => {
    const f = pendingStream(); vi.mocked(apiStream).mockReturnValue(f.iterator);
    const frame = source(); message(frame); await flush();
    expect(apiStream).toHaveBeenCalledWith('plugins.execStream', { namespace: 'owned-plugin', projectId: 7 });
    message(frame, 'closeStream'); message(frame, 'closeStream'); await flush();
    expect(f.iterator.return).toHaveBeenCalledOnce();
    f.deliver('late'); await flush();
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('releases all streams on frame removal without touching another frame', async () => {
    const a = pendingStream(), b = pendingStream(), c = pendingStream();
    vi.mocked(apiStream).mockReturnValueOnce(a.iterator).mockReturnValueOnce(b.iterator).mockReturnValueOnce(c.iterator);
    const first = source(), second = source();
    message(first, 'openStream', 1); message(first, 'openStream', 2); message(second); await flush();
    unregisterPluginFrame(first); await flush();
    expect(a.iterator.return).toHaveBeenCalledOnce(); expect(b.iterator.return).toHaveBeenCalledOnce();
    expect(c.iterator.return).not.toHaveBeenCalled();
    a.deliver('late'); c.deliver('live'); await flush();
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({ event: 'data', value: 'live' }), '*');
  });

  it('supersedes duplicate ids without letting the old finally remove the new owner', async () => {
    const old = pendingStream(), current = pendingStream();
    vi.mocked(apiStream).mockReturnValueOnce(old.iterator).mockReturnValueOnce(current.iterator);
    const frame = source(); message(frame); await flush(); message(frame); await flush();
    expect(old.iterator.return).toHaveBeenCalledOnce();
    old.deliver('obsolete'); await flush();
    message(frame, 'closeStream'); await flush();
    expect(current.iterator.return).toHaveBeenCalledOnce();
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('does not create a stream if the frame disappears during identity resolution', async () => {
    const frame = { postMessage: vi.fn() } as unknown as WindowProxy;
    message(frame); unregisterPluginFrame(frame);
    await vi.advanceTimersByTimeAsync(60); await flush();
    expect(apiStream).not.toHaveBeenCalled(); expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('disposes live subscriptions when the bridge unmounts', async () => {
    const f = pendingStream(); vi.mocked(apiStream).mockReturnValue(f.iterator);
    const frame = source(); message(frame); await flush(); dispose(); await flush();
    expect(f.iterator.return).toHaveBeenCalledOnce();
    f.deliver('late'); await flush(); expect(frame.postMessage).not.toHaveBeenCalled();
  });
});
