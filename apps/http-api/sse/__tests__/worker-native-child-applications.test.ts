import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerWorkerNativeMemoryCalls } from '../worker-native-memory-calls.js';
import { registerWorkerNativeExportCalls } from '../worker-native-export-calls.js';
import { registerWorkerNativeIndexCalls } from '../worker-native-index-calls.js';
const fake = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../native-application-dispatch.js', () => ({ authorizeNativeApplicationDispatch: fake.authorize }));
beforeEach(() => fake.authorize.mockReset().mockResolvedValue({ assertDispatch() {} }));
const surfaces = [
  { channel: 'nativeMemory', action: 'Mutate', tool: 'remember', input: { title: 'A', content: 'B', scope: 'project' } },
  { channel: 'nativeExport', action: 'Publish', tool: 'mcp__export_docs', input: { sections: ['files'] } },
  { channel: 'nativeIndex', action: 'Reconcile', tool: 'mcp__index_project', input: {} },
] as const;
function fixture(surface: typeof surfaces[number]) {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  let release!: () => void;
  const effect = vi.fn(async () => 'result');
  const lookup = vi.fn(async (_runId: unknown, closing?: boolean, child?: string) => {
    if (child !== 'a' && child !== 'b') throw new Error('foreign child');
    if (blocked && !closing) await new Promise<void>(resolve => { release = resolve; });
    return { sessionId: 's', projectId: 7, signal: new AbortController().signal, assertOwner() {},
      config: { context: { agentRunId: child, attemptId: child } } as any, store: {} as any };
  });
  let blocked = false;
  const off = surface.channel === 'nativeMemory'
    ? registerWorkerNativeMemoryCalls(main, lookup, () => ({ projectMemory: { save: effect, recall: vi.fn() } } as any))
    : surface.channel === 'nativeExport' ? registerWorkerNativeExportCalls(main, lookup, () => ({ exportProject: effect }))
    : registerWorkerNativeIndexCalls(main, lookup, () => ({ reconcile: effect }));
  const packet = (child: string) => ({ runId: 1, agentRunId: child, requestId: 'same-model-call', key: `coder-s-attempt-${child}`,
    authority: { toolName: surface.tool, toolUseId: 'same-model-call', input: surface.input, payload: {} } });
  return { worker, lookup, effect, packet, block() { blocked = true; }, release() { blocked = false; release?.(); },
    close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
it.each(surfaces)('$channel isolates equal tool IDs and keeps both drained attempts fenced', async surface => {
  const f = fixture(surface); const method = surface.channel + surface.action;
  try {
    await f.worker.request(method, f.packet('a')); await f.worker.request(method, f.packet('b'));
    await f.worker.request(method, f.packet('a')); expect(f.effect).toHaveBeenCalledTimes(2);
    for (const child of ['a', 'b']) await f.worker.request(surface.channel + 'Drain', { runId: 1, agentRunId: child, attemptId: child });
    for (const child of ['a', 'b']) await expect(f.worker.request(method, f.packet(child))).rejects.toThrow('draining');
    expect(f.effect).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});
it.each(surfaces.flatMap(surface => ['Cancel', 'Drain'].map(close => ({ ...surface, close }))))(
  '$channel $close owns a request still waiting for child authority', async surface => {
    const f = fixture(surface); f.block();
    const pending = f.worker.request(surface.channel + surface.action, f.packet('a'));
    const rejected = expect(pending).rejects.toThrow(/cancelled|closed|draining/);
    try {
      await vi.waitFor(() => expect(f.lookup).toHaveBeenCalled());
      let settled = false;
      const closing = f.worker.request(surface.channel + surface.close,
        { runId: 1, agentRunId: 'a', attemptId: 'a', requestId: 'same-model-call' }).then(value => { settled = true; return value; });
      await vi.waitFor(() => expect(f.lookup).toHaveBeenCalledTimes(2)); expect(settled).toBe(false);
      f.release(); await rejected; await expect(closing).resolves.toEqual({ closed: true });
      expect(f.effect).not.toHaveBeenCalled(); expect(fake.authorize).not.toHaveBeenCalled();
    } finally { f.release(); f.close(); }
  });
