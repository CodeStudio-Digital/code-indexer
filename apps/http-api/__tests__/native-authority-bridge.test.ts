import { randomUUID } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { PreparedDurabilityFacts } from '@mcp/agent-runtime-host';
import { dispatchNativeAuthority, workerNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const context = { sessionId: randomUUID(), commandId: randomUUID(), agentRunId: randomUUID(),
  attemptId: randomUUID(), correlationId: randomUUID(), executorOwnerId: 'owner:1', fencingEpoch: 2,
} as ControlPlaneRunContext;

it('keeps its own nonce copy across asynchronous activation and rejects cross-attempt calls locally', async () => {
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 });
  const worker = new MessageBridge({ port: channel.port2 });
  cleanup.push(() => { main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); });
  const received: NativeAuthorityOperation[] = [];
  main.handle('native.authority', (payload) => { received.push((payload as { operation: NativeAuthorityOperation }).operation); return {}; });
  const authority = workerNativeAuthority(worker, 3, context);
  const nonce = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const port = authority.createNativeActivationPort(context, nonce);
  nonce.fill(0);
  await port.commitPrepared({} as PreparedDurabilityFacts, { signal: new AbortController().signal,
    deadlineAtUnixMs: BigInt(Date.now() + 1_000) });
  const operation = received[0];
  expect(operation.kind).toBe('activate');
  if (operation.kind === 'activate') expect([...operation.nonce]).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  expect(() => authority.getAttemptState({ ...context, attemptId: randomUUID() as typeof context.attemptId })).toThrow('identity');
  expect(received).toHaveLength(1);
});

it('checks ownership both before dispatch and after awaited I/O', async () => {
  let resolve!: (value: never) => void;
  const read = vi.fn(() => new Promise<never>(done => { resolve = done; }));
  const authority = { getAttemptState: read } as unknown as NativeProductAuthority;
  let live = true;
  const assertOwner = () => { if (!live) throw new Error('retired owner'); };
  const pending = dispatchNativeAuthority({ authority, context,
    operation: { kind: 'state', requireActiveLease: true }, assertOwner });
  live = false; resolve({} as never);
  await expect(pending).rejects.toThrow('retired owner');
  await expect(dispatchNativeAuthority({ authority, context,
    operation: { kind: 'state', requireActiveLease: true }, assertOwner })).rejects.toThrow('retired owner');
  expect(read).toHaveBeenCalledTimes(1);
});

it('rejects expired activation deadlines before committing prepared', async () => {
  const commitPrepared = vi.fn();
  const authority = { createNativeActivationPort: () => ({ commitPrepared }) } as unknown as NativeProductAuthority;
  await expect(dispatchNativeAuthority({ authority, context, assertOwner() {}, operation: {
    kind: 'activate', nonce: new Uint8Array(32), facts: {} as PreparedDurabilityFacts,
    deadlineAtUnixMs: BigInt(Date.now() - 1),
  } })).rejects.toThrow('deadline');
  expect(commitPrepared).not.toHaveBeenCalled();
});

it('routes child requests through the durable root lookup and preserves cleanup after root cancellation', async () => {
  const child = { ...context, agentRunId: randomUUID() as typeof context.agentRunId,
    attemptId: randomUUID() as typeof context.attemptId };
  const resolveNativeChild = vi.fn(async (_root: ControlPlaneRunContext, id: string, active: boolean) => {
    if (id !== child.agentRunId) throw new Error('foreign child');
    expect(_root).toEqual(context); return child;
  });
  const state = vi.fn(async () => ({})), cancel = vi.fn(async () => true);
  const authority = { resolveNativeChild, getAttemptState: state, commitRuntimeRequest: cancel } as unknown as
    NativeProductAuthority & { resolveNativeChild: typeof resolveNativeChild };
  await dispatchNativeAuthority({ authority, context, agentRunId: child.agentRunId,
    operation: { kind: 'state', requireActiveLease: true }, assertOwner() {} });
  expect(resolveNativeChild).toHaveBeenLastCalledWith(context, child.agentRunId, true);
  expect(state).toHaveBeenLastCalledWith(child, true);
  await dispatchNativeAuthority({ authority, context, agentRunId: child.agentRunId,
    operation: { kind: 'request', key: 'cancel', payload: { code: 'ancestor_cancelled' } }, assertOwner() {} });
  expect(resolveNativeChild).toHaveBeenLastCalledWith(context, child.agentRunId, false);
  expect(cancel).toHaveBeenCalledWith(child, 'cancel', { code: 'ancestor_cancelled' });
  await expect(dispatchNativeAuthority({ authority, context, agentRunId: 'foreign',
    operation: { kind: 'state', requireActiveLease: true }, assertOwner() {} })).rejects.toThrow('foreign child');
  expect(state).toHaveBeenCalledOnce();
});

it('includes the bound child identity on the physical worker bridge and rechecks ownership after resolution', async () => {
  const channel = new MessageChannel(); const main = new MessageBridge({ port: channel.port1 });
  const worker = new MessageBridge({ port: channel.port2 });
  cleanup.push(() => { main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close(); });
  const received: unknown[] = [];
  main.handle('native.authority', payload => { received.push(payload); return {}; });
  await workerNativeAuthority(worker, 3, context).getAttemptState(context);
  expect(received).toEqual([{ runId: 3, agentRunId: context.agentRunId, operation: { kind: 'state', requireActiveLease: true } }]);
  const state = vi.fn(); let live = true;
  const authority = { getAttemptState: state, resolveNativeChild: async () => { live = false; return context; } } as unknown as
    NativeProductAuthority & { resolveNativeChild(): Promise<ControlPlaneRunContext> };
  await expect(dispatchNativeAuthority({ authority, context, agentRunId: 'child', operation: { kind: 'state', requireActiveLease: true },
    assertOwner: () => { if (!live) throw new Error('retired owner'); } })).rejects.toThrow('retired owner');
  expect(state).not.toHaveBeenCalled();
});
