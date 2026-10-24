import { MessageChannel } from 'node:worker_threads';
import { beforeEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { registerWorkerNativeMemoryCalls } from '../worker-native-memory-calls.js';
const fake = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../native-application-dispatch.js', () => ({ authorizeNativeApplicationDispatch: fake.authorize }));
beforeEach(() => fake.authorize.mockReset().mockResolvedValue({ assertDispatch() {} }));
function fixture() {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const signal = new AbortController();
  const save = vi.fn(async (..._args: any[]) => ({ created: 1, merged: 0, skipped: 0 }));
  const forget = vi.fn(async (..._args: any[]) => ({ archived: 1 }));
  const off = registerWorkerNativeMemoryCalls(main, runId => {
    if (runId !== 1) throw new Error('stale owner');
    return { sessionId: 's', projectId: 7, signal: signal.signal, assertOwner: () => signal.signal.throwIfAborted(),
      config: { context: { sessionId: 's', attemptId: 'a' } } as any, store: {} as any };
  }, () => ({ projectMemory: { save, forget, recall: vi.fn() } }));
  return { worker, save, forget, signal, close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
const packet = (scope = 'project') => ({ key: 'coder-s-attempt-a', requestId: 'memory-1', runId: 1,
  authority: { toolUseId: 'memory-1', toolName: 'remember', input: { title: 'Convention', content: 'Use bounded reads', scope }, payload: {} } });
it.each(['project', 'user'])('pins %s persistence to the host owner, never an untrusted project ID', async scope => {
  const f = fixture();
  try {
    const request = { ...packet(scope), projectId: 900, projectName: 'forged' };
    await f.worker.request('nativeMemoryMutate', request);
    expect(f.save).toHaveBeenCalledWith(scope === 'user' ? 0 : 7, '', expect.objectContaining({ title: 'Convention' }),
      expect.objectContaining({ deferEmbeddings: true, signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }));
    expect(fake.authorize.mock.calls[0][2]).toMatchObject({ databaseId: `memory:${scope}`, operation: 'remember.save' });
  } finally { f.close(); }
});
it('returns the existing receipt for duplicate packets and rejects reuse with different input', async () => {
  const f = fixture();
  try {
    await Promise.all([f.worker.request('nativeMemoryMutate', packet()), f.worker.request('nativeMemoryMutate', packet())]);
    expect(f.save).toHaveBeenCalledTimes(1);
    await expect(f.worker.request('nativeMemoryMutate', packet('user'))).rejects.toThrow('changed input');
    expect(f.save).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});
it('archives only through the authorized scope and operation', async () => {
  const f = fixture();
  try {
    const request = packet(); request.authority = { toolUseId: 'memory-1', toolName: 'forget_memory', input: { target: 'Convention', scope: 'user' }, payload: {} } as any;
    await expect(f.worker.request('nativeMemoryMutate', request)).resolves.toEqual({ archived: 1 });
    expect(f.forget.mock.calls[0].slice(0, 3)).toEqual([0, '', 'Convention']);
    expect(fake.authorize.mock.calls[0][2]).toMatchObject({ databaseId: 'memory:user', operation: 'forget_memory.archive' });
  } finally { f.close(); }
});
it.each(['nativeMemoryCancel', 'nativeMemoryDrain'])('%s waits for owned work and fences a write still awaiting authorization', async method => {
  const f = fixture(); let release!: () => void;
  fake.authorize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { assertDispatch() {} }; });
  const pending = f.worker.request('nativeMemoryMutate', packet());
  const rejected = expect(pending).rejects.toThrow(/cancelled|closed/);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let settled = false;
    const closing = f.worker.request(method, { requestId: 'memory-1', runId: 1, attemptId: 'a' }).then(r => { settled = true; return r; });
    await new Promise(r => setTimeout(r, 20)); expect(settled).toBe(false);
    release(); await rejected; await expect(closing).resolves.toEqual({ closed: true });
    expect(f.save).not.toHaveBeenCalled();
    if (method === 'nativeMemoryDrain') await expect(f.worker.request('nativeMemoryMutate', packet())).rejects.toThrow('draining');
  } finally { release?.(); f.close(); }
});
it('a revoked owner cannot publish a successful receipt even if a non-cooperative write finishes', async () => {
  const f = fixture(); f.save.mockImplementationOnce(async () => { f.signal.abort(new Error('revoked')); return { created: 1, merged: 0, skipped: 0 }; });
  try { await expect(f.worker.request('nativeMemoryMutate', packet())).rejects.toThrow('revoked'); }
  finally { f.close(); }
});
it('pins MCP saves to the project owner and forwards rich metadata without accepting scope injection', async () => {
  const f = fixture();
  try {
    const request = packet('user');
    request.authority.toolName = 'mcp__save_memory';
    Object.assign(request.authority.input, { category: 'architecture', importance: 0.93, referenced_files: ['src/index.ts'], projectId: 999 });
    await Promise.all([f.worker.request('nativeMemoryMutate', request), f.worker.request('nativeMemoryMutate', request)]);
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save.mock.calls[0].slice(0, 3)).toEqual([7, '', { title: 'Convention', content: 'Use bounded reads', category: 'architecture', importance: 0.93, referencedFiles: ['src/index.ts'] }]);
    expect(fake.authorize.mock.calls[0][2]).toMatchObject({ name: 'mcp__save_memory', databaseId: 'memory:project', operation: 'save_memory.save' });
  } finally { f.close(); }
});
it('rejects an operation ID that does not match the sealed invocation', async () => {
  const f = fixture();
  try { await expect(f.worker.request('nativeMemoryMutate', { ...packet(), requestId: 'foreign' })).rejects.toThrow('identity differs');
    expect(f.save).not.toHaveBeenCalled(); expect(fake.authorize).not.toHaveBeenCalled();
  } finally { f.close(); }
});
