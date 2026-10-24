import { MessageChannel } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { setGlobalPreviewDevtools } from '@mcp/code-agent/tools/preview/index.js';
import { registerWorkerPreviewCalls } from '../worker-preview-calls.js';

afterEach(() => { setGlobalPreviewDevtools(null); vi.clearAllMocks(); });

function fixture(beforeOwner?: () => Promise<void>) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const controller = new AbortController();
  const backend = { invoke: vi.fn(async () => ({ ok: true })) }; setGlobalPreviewDevtools(backend);
  const off = registerWorkerPreviewCalls(main, async runId => {
    if (runId !== 1) throw new Error('stale owner');
    await beforeOwner?.();
    return { sessionId: 's', projectId: 7, signal: controller.signal, assertOwner: () => {} };
  });
  return { worker, backend, off, close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
const request = { key: 'coder-s', method: 'open', args: { url: 'http://localhost:3' }, requestId: 'preview-1', runId: 1 };
it('dispatches an owned worker request through the application backend', async () => {
  const f = fixture();
  try {
    await expect(f.worker.request('previewDevtools', request)).resolves.toEqual({ ok: true });
    expect(f.backend.invoke).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it('cancellation while ownership is being resolved prevents physical dispatch', async () => {
  let release!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.worker.request('previewDevtools', request);
  const rejected = expect(pending).rejects.toThrow('cancelled');
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.worker.request('previewDevtoolsCancel', { requestId: request.requestId });
    release(); await rejected; expect(f.backend.invoke).not.toHaveBeenCalled();
  } finally { release?.(); f.close(); }
});
it('closing the bridge while ownership is being resolved prevents late dispatch', async () => {
  let release!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = f.worker.request('previewDevtools', request);
  const rejected = expect(pending).rejects.toThrow(/bridge closed|scope closed/);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.off(); release(); await rejected; expect(f.backend.invoke).not.toHaveBeenCalled();
  } finally { release?.(); f.close(); }
});
it('workers cannot address another session or call host-only operations', async () => {
  const f = fixture();
  try {
    await expect(f.worker.request('previewDevtools', { ...request, key: 'coder-foreign' })).rejects.toThrow('foreign owner');
    await expect(f.worker.request('previewDevtools', { ...request, method: 'closeSessionPrefix' })).rejects.toThrow('not an admitted tool');
    await expect(f.worker.request('previewDevtools', { ...request, runId: 2 })).rejects.toThrow('stale owner');
    expect(f.backend.invoke).not.toHaveBeenCalled();
  } finally { f.close(); }
});
