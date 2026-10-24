import { MessageChannel } from 'node:worker_threads';
import { beforeEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { registerWorkerNativeIndexCalls } from '../worker-native-index-calls.js';
const fake = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../native-application-dispatch.js', () => ({ authorizeNativeApplicationDispatch: fake.authorize }));
beforeEach(() => fake.authorize.mockReset().mockResolvedValue({ assertDispatch() {} }));
function fixture() {
  const channel = new MessageChannel(); const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const signal = new AbortController(); const reconcile = vi.fn(async (..._args: any[]) => 'job #19');
  const off = registerWorkerNativeIndexCalls(main, runId => {
    if (runId !== 1) throw new Error('stale owner');
    return { sessionId: 's', projectId: 7, signal: signal.signal, assertOwner: () => signal.signal.throwIfAborted(),
      config: { context: { sessionId: 's', attemptId: 'a' } } as any, store: {} as any };
  }, () => ({ reconcile }));
  return { worker, reconcile, signal, close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
const packet = (id = 'index-1') => ({ key: 'coder-s-attempt-a', requestId: id, runId: 1,
  authority: { toolName: 'mcp__index_project', toolUseId: id, input: { project_path: 'D:/owned' }, payload: {} } });
it('pins the project and exact authorized indexing operation, deduplicating concurrent requests', async () => {
  const f = fixture();
  try {
    const request = { ...packet(), projectId: 999 };
    await Promise.all([f.worker.request('nativeIndexReconcile', request), f.worker.request('nativeIndexReconcile', request)]);
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledWith(7, request.authority.input, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fake.authorize.mock.calls[0][2]).toMatchObject({ name: 'mcp__index_project', operation: 'index/reconcile' });
    await expect(f.worker.request('nativeIndexReconcile', packet())).rejects.toThrow('changed input');
    await expect(f.worker.request('nativeIndexReconcile', { ...packet('index-2'), runId: 9 })).rejects.toThrow('stale owner');
  } finally { f.close(); }
});
it.each(['nativeIndexCancel', 'nativeIndexDrain'])('%s waits for physical settlement and fences later mutations', async method => {
  const f = fixture(); let release!: () => void;
  fake.authorize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { assertDispatch() {} }; });
  const pending = f.worker.request('nativeIndexReconcile', packet()); const rejected = expect(pending).rejects.toThrow(/cancelled|closed/);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.worker.request('nativeIndexReconcile', packet('index-2'))).rejects.toThrow('pending');
    let settled = false;
    const closing = f.worker.request(method, { requestId: 'index-1', runId: 1, attemptId: 'a' }).then(r => { settled = true; return r; });
    await new Promise(r => setTimeout(r, 20)); expect(settled).toBe(false);
    release(); await rejected; await expect(closing).resolves.toEqual({ closed: true });
    expect(f.reconcile).not.toHaveBeenCalled();
    if (method === 'nativeIndexDrain') await expect(f.worker.request('nativeIndexReconcile', packet('index-3'))).rejects.toThrow('draining');
  } finally { release?.(); f.close(); }
});
it('never repeats a failed receipt even after the indexing effect completed', async () => {
  const f = fixture(); f.reconcile.mockRejectedValueOnce(new Error('ACK lost'));
  try {
    await expect(f.worker.request('nativeIndexReconcile', packet())).rejects.toThrow('ACK lost');
    await expect(f.worker.request('nativeIndexReconcile', packet())).rejects.toThrow('ACK lost');
    expect(f.reconcile).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it('rejects mismatched invocation identities and oversized input before dispatch', async () => {
  const f = fixture();
  try {
    const request = packet(); request.authority.toolUseId = 'foreign';
    await expect(f.worker.request('nativeIndexReconcile', request)).rejects.toThrow('Invalid');
    const large = packet(); large.authority.input.project_path = 'x'.repeat(65536);
    await expect(f.worker.request('nativeIndexReconcile', large)).rejects.toThrow('Invalid');
    expect(f.reconcile).not.toHaveBeenCalled();
  } finally { f.close(); }
});
