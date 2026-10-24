import { MessageChannel } from 'node:worker_threads';
import { beforeEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { registerWorkerNativeExportCalls } from '../worker-native-export-calls.js';
const fake = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../native-application-dispatch.js', () => ({ authorizeNativeApplicationDispatch: fake.authorize }));
beforeEach(() => fake.authorize.mockReset().mockResolvedValue({ assertDispatch() {} }));
function fixture() {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const signal = new AbortController();
  const exportProject = vi.fn(async (..._args: any[]) => '# Documentation');
  const off = registerWorkerNativeExportCalls(main, runId => {
    if (runId !== 1) throw new Error('stale owner');
    return { sessionId: 's', projectId: 7, signal: signal.signal, assertOwner: () => signal.signal.throwIfAborted(),
      config: { context: { sessionId: 's', attemptId: 'a' } } as any, store: {} as any };
  }, () => ({ exportProject }));
  return { worker, exportProject, signal, close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
const packet = () => ({ key: 'coder-s-attempt-a', requestId: 'export-1', runId: 1,
  authority: { toolName: 'mcp__export_docs', toolUseId: 'export-1', input: { sections: ['files'] }, payload: {} } });
it('pins export to the host project and checks the exact publication resource', async () => {
  const f = fixture();
  try {
    await f.worker.request('nativeExportPublish', { ...packet(), projectId: 900 });
    expect(f.exportProject).toHaveBeenCalledWith(7, { sections: ['files'] }, expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }));
    expect(fake.authorize.mock.calls[0][2]).toMatchObject({ name: 'mcp__export_docs', operation: 'export/publish' });
  } finally { f.close(); }
});
it('retains the receipt for duplicates and rejects changed input or tool identities', async () => {
  const f = fixture();
  try {
    await Promise.all([f.worker.request('nativeExportPublish', packet()), f.worker.request('nativeExportPublish', packet())]);
    expect(f.exportProject).toHaveBeenCalledOnce();
    const changed = packet(); changed.authority.input.sections = ['symbols'];
    await expect(f.worker.request('nativeExportPublish', changed)).rejects.toThrow('changed input');
    const mismatch = packet(); mismatch.authority.toolUseId = 'foreign';
    await expect(f.worker.request('nativeExportPublish', mismatch)).rejects.toThrow('Invalid');
    expect(f.exportProject).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it.each(['nativeExportCancel', 'nativeExportDrain'])('%s waits for pending authority and fences publication', async method => {
  const f = fixture(); let release!: () => void;
  fake.authorize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { assertDispatch() {} }; });
  const pending = f.worker.request('nativeExportPublish', packet()); const rejected = expect(pending).rejects.toThrow(/cancelled|closed/);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let settled = false;
    const closing = f.worker.request(method, { requestId: 'export-1', runId: 1, attemptId: 'a' }).then(r => { settled = true; return r; });
    await new Promise(r => setTimeout(r, 20)); expect(settled).toBe(false);
    release(); await rejected; await expect(closing).resolves.toEqual({ closed: true });
    expect(f.exportProject).not.toHaveBeenCalled();
    if (method === 'nativeExportDrain') await expect(f.worker.request('nativeExportPublish', packet())).rejects.toThrow('draining');
  } finally { release?.(); f.close(); }
});
it('retains a failed receipt so a committed export with lost ACK cannot run again', async () => {
  const f = fixture(); f.exportProject.mockRejectedValueOnce(new Error('ACK lost'));
  try {
    await expect(f.worker.request('nativeExportPublish', packet())).rejects.toThrow('ACK lost');
    await expect(f.worker.request('nativeExportPublish', packet())).rejects.toThrow('ACK lost');
    expect(f.exportProject).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it('limits retained document bytes without invalidating previous receipts', async () => {
  const f = fixture(); f.exportProject.mockResolvedValueOnce('x'.repeat(32 * 1024 * 1024));
  try {
    await f.worker.request('nativeExportPublish', packet());
    const second = packet(); second.requestId = second.authority.toolUseId = 'export-2';
    await expect(f.worker.request('nativeExportPublish', second)).rejects.toThrow('budget exhausted');
    expect((await f.worker.request<string>('nativeExportPublish', packet())).length).toBe(32 * 1024 * 1024);
    expect(f.exportProject).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
