import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { mountIpcHandlers } from '../handlers-mount.js';

const state = vi.hoisted(() => ({
  ports: [] as Array<{ port1: { close: ReturnType<typeof vi.fn> }; port2: EventEmitter & { close: ReturnType<typeof vi.fn> } }>,
  runs: [] as Array<{ signal: AbortSignal; returned: ReturnType<typeof vi.fn> }>,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Port extends EventEmitter {
    start = vi.fn(); close = vi.fn(() => { this.emit('close'); }); postMessage = vi.fn();
  }
  return {
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn() }),
    MessageChannelMain: class {
      port1 = new Port(); port2 = new Port();
      constructor() { state.ports.push(this); }
    },
  };
});
vi.mock('@mcp/api-handlers', () => ({
  createContext: (value: unknown) => value,
  createHandlers: () => ({ terminal: { output: (_payload: unknown, ctx: { signal: AbortSignal }) => {
    const returned = vi.fn(async () => ({ value: undefined, done: true }));
    state.runs.push({ signal: ctx.signal, returned });
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: returned }) };
  } } }),
}));
vi.mock('@apps/http-api/server/hono-dispatch.js', () => ({
  DISPATCH_TABLE: {}, STREAMING_DISPATCH_PATHS: new Set(), dispatchHono: vi.fn(), dispatchStreaming: vi.fn(),
}));
vi.mock('@apps/http-api/server/perf/slow-ipc.js', () => ({ timeCall: (_name: string, fn: () => unknown) => fn() }));

beforeAll(() => { mountIpcHandlers({} as never); });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let senderId = 100;
function sender() { return Object.assign(new EventEmitter(), { id: senderId++, postMessage: vi.fn() }); }

describe('IPC stream cancellation routing', () => {
  it('cancels by request id only within the owning renderer, before consuming a port', async () => {
    const owner = sender(), foreign = sender();
    ipcMain.emit('stream:api:terminal:output', { sender: owner }, { requestId: 'same-id', payload: {} });
    const run = state.runs.at(-1)!, ports = state.ports.at(-1)!;
    expect(owner.postMessage).toHaveBeenCalledWith('stream-port:same-id', null, [ports.port1]);
    ipcMain.emit('api:cancel-stream', { sender: foreign }, 'same-id');
    expect(run.signal.aborted).toBe(false);
    ipcMain.emit('api:cancel-stream', { sender: owner }, 'same-id');
    ipcMain.emit('api:cancel-stream', { sender: owner }, 'same-id');
    await flush();
    expect(run.signal.aborted).toBe(true); expect(run.returned).toHaveBeenCalledOnce();
    expect(ports.port2.close).toHaveBeenCalledOnce();
  });

  it('does not start a producer after a failed port transfer', async () => {
    const owner = sender(), before = state.runs.length;
    owner.postMessage.mockImplementation(() => { throw new Error('renderer destroyed'); });
    ipcMain.emit('stream:api:terminal:output', { sender: owner }, { requestId: 'failed-transfer', payload: {} });
    await flush();
    expect(state.runs).toHaveLength(before);
    expect(state.ports.at(-1)!.port1.close).toHaveBeenCalledOnce();
    expect(state.ports.at(-1)!.port2.close).toHaveBeenCalledOnce();
    // Reusing the id in a healthy renderer has no stale controller attached.
    const healthy = sender();
    ipcMain.emit('api:cancel-stream', { sender: healthy }, 'failed-transfer');
  });
});
