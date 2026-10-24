import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { expect, it, vi } from 'vitest';
import { registerWorkerAgentReadCalls } from '../worker-agent-read-calls.js';
import { createWorkerAgentReadPort } from '../../workers/agent-read-port.js';

function fixture() {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  const controller = new AbortController();
  const read = vi.fn(async (..._args: any[]): Promise<unknown> => ({ owned: true }));
  const off = registerWorkerAgentReadCalls(main, runId => {
    if (runId !== 1) throw new Error('stale worker');
    return { sessionId: 's', projectId: 7, signal: controller.signal, assertOwner: () => controller.signal.throwIfAborted() };
  }, () => ({ read }));
  return { read, worker, controller, port: createWorkerAgentReadPort(worker, 1, controller.signal, () => controller.signal.throwIfAborted()),
    close() { off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); } };
}
it('uses the Host project and forbids mutation names and stale runs', async () => {
  const f = fixture(); try {
    expect(await f.port.read('list_agents', { project_id: 900 })).toEqual({ owned: true });
    expect(f.read).toHaveBeenCalledWith(7, 'list_agents', { project_id: 900 }, expect.any(AbortSignal));
    for (const packet of [{ name: 'start_agent_run', runId: 1 }, { name: 'list_agents', runId: 2 }]) {
      await expect(f.worker.request('ownedAgentRead', { ...packet, requestId: 'bad', input: {} })).rejects.toThrow();
    }
    expect(f.read).toHaveBeenCalledOnce();
  } finally { f.close(); }
});
it('keeps cancellation pending until the actual read settles and suppresses its result', async () => {
  const f = fixture(); let release!: () => void; const caller = new AbortController();
  f.read.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return { late: true }; });
  try {
    const result = f.port.read('get_agent_run', { run_id: 'fixture' }, caller.signal);
    const rejected = expect(result).rejects.toThrow(/cancelled|abort/i);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    caller.abort(); let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false);
    release(); await rejected;
  } finally { release?.(); f.close(); }
});
