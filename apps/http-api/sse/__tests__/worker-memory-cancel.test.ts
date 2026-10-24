import { MessageChannel } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';
import { MessageBridge } from '../../../../packages/orchestrator-host/src/index.js';
import { buildWorkerMemoryShims } from '../../workers/memory-shims.js';
import { registerWorkerMemoryHandlers } from '../worker-memory-handlers.js';
import { WorkerMemoryReads } from '../worker-memory-reads.js';

it.each(['search', 'list'] as const)('cancels explicit memory %s across a real MessageChannel without returning empty success', async mode => {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 });
  const worker = new MessageBridge({ port: channel.port2 });
  const ctrl = new AbortController();
  let received: AbortSignal | undefined;
  let release!: (value: []) => void;
  const read = (signal?: AbortSignal) => { received = signal; return new Promise<[]>((resolve) => { release = resolve; }); };
  const off = registerWorkerMemoryHandlers(main, () => ({ projectMemory: {
    save: async () => null,
    recall: (_id, _name, _query, _limit, signal) => read(signal),
    list: (_id, _name, _limit, _type, signal) => read(signal),
  } }));
  try {
    const shims = buildWorkerMemoryShims(worker);
    const pending = mode === 'search' ? shims.projectMemory.recall(1, 'p', 'query', 5, ctrl.signal)
      : shims.projectMemory.list(1, 'p', 5, undefined, ctrl.signal);
    const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(received).toBeDefined());
    ctrl.abort();
    await failed;
    await vi.waitFor(() => expect(received?.aborted).toBe(true));
    release([]); // an adapter that finishes late cannot turn cancellation into success
  } finally {
    release?.([]); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close();
  }
});

it('keeps cancelled non-cooperative reads bounded and aborts remaining reads when the bridge closes', async () => {
  const reads = new WorkerMemoryReads();
  const signals: AbortSignal[] = [];
  const release: Array<() => void> = [];
  const pending = Array.from({ length: 32 }, (_, index) => reads.run(`read-id-${index}`, signal => {
    signals.push(signal!);
    return new Promise<void>(resolve => release.push(resolve));
  }));
  await vi.waitFor(() => expect(signals).toHaveLength(32));
  const finished = Promise.allSettled(pending);
  reads.cancel('read-id-0');
  await expect(reads.run('read-id-extra', async () => {})).rejects.toThrow('saturated');
  reads.close();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect((await finished).every(result => result.status === 'rejected')).toBe(true);
  for (const resolve of release) resolve();
  await expect(reads.run('read-after-close', async () => {})).rejects.toThrow('closed');
});
