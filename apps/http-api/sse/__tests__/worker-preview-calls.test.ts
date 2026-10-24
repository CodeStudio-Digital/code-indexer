import { MessageChannel } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { setGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import { registerWorkerPreviewCalls } from '../worker-preview-calls.js';

const fake = vi.hoisted(() => ({ authorize: vi.fn(), invoke: vi.fn(), close: vi.fn(async () => undefined) }));
vi.mock('../../native-preview-dispatch.js', () => ({ authorizeNativePreviewDispatch: fake.authorize }));
vi.mock('../../native-preview-attempt.js', () => ({ NativePreviewAttempt: class { invoke = fake.invoke; close = fake.close; } }));
afterEach(() => { setGlobalPreviewDevtools(null); vi.clearAllMocks(); });

function fixture(native = true) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const controller = new AbortController();
  const backend = { invoke: vi.fn(async () => ({})) }; setGlobalPreviewDevtools(backend);
  const off = registerWorkerPreviewCalls(main, runId => {
    if (runId !== 1) throw new Error('stale owner');
    return { sessionId: 's', projectId: 7, signal: controller.signal, assertOwner: () => {},
      ...(native ? { config: { context: { sessionId: 's', attemptId: 'a' } } as any, store: {} as any } : {}) };
  });
  return { worker, backend, close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
const request = { key: 'coder-s-attempt-a', method: 'open', args: { url: 'http://localhost:3' }, requestId: 'preview-1', runId: 1 };
it('a drain fences a call still awaiting authority, so no late effect can follow its ACK', async () => {
  const f = fixture(); let release!: () => void;
  fake.authorize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return {}; });
  const pending = f.worker.request('previewDevtools', request);
  const rejected = expect(pending).rejects.toThrow(/scope closed|draining/);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.worker.request('previewDevtoolsDrain', { runId: 1, attemptId: 'a' })).resolves.toEqual({ closed: true });
    release(); await rejected; expect(fake.invoke).not.toHaveBeenCalled();
  } finally { release?.(); f.close(); }
});
it('cancellation during authorization prevents physical dispatch', async () => {
  const f = fixture(); let release!: () => void;
  fake.authorize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return {}; });
  const pending = f.worker.request('previewDevtools', request);
  const rejected = expect(pending).rejects.toThrow('cancelled');
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.worker.request('previewDevtoolsCancel', { requestId: request.requestId });
    release(); await rejected; expect(fake.invoke).not.toHaveBeenCalled();
  } finally { release?.(); f.close(); }
});
it('legacy workers cannot close another session or call host-only operations', async () => {
  const f = fixture(false);
  try {
    await expect(f.worker.request('previewDevtools', request)).rejects.toThrow('foreign owner');
    await expect(f.worker.request('previewDevtools', { ...request, key: 'coder-s', method: 'closeSessionPrefix' })).rejects.toThrow('not an admitted tool');
    await expect(f.worker.request('previewDevtools', { ...request, key: 'coder-s', runId: 2 })).rejects.toThrow('stale owner');
    expect(f.backend.invoke).not.toHaveBeenCalled();
  } finally { f.close(); }
});
