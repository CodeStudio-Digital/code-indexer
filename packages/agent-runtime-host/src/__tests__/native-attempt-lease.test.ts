import { create } from '@bufbuild/protobuf';
import { agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { NativeAttemptLease, type NativeAttemptLifecycle } from '../native/NativeAttemptLease.js';
import { NativeEngineCompletion } from '../native/NativeEngineCompletion.js';
import type { ActiveAttemptAuthorityHandle } from '../driver/HostLifecycleReceipts.js';

describe('native attempt lifecycle lease', () => {
  it('publishes completion only after the durable event acknowledgement', async () => {
    const completion = new NativeEngineCompletion();
    const settled = vi.fn();
    void completion.settled.then(settled);
    completion.acknowledge(create(agentV1SessionStore.EngineEventRecordV1Schema, {
      body: { case: 'providerStarted', value: { operationId: 'provider/1' } },
    }));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    completion.acknowledge(terminal());
    await completion.settled;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('releases a completed runner and its supervisor exactly once', async () => {
    const h = harness();
    h.terminal.resolve(terminal());
    await vi.waitFor(() => expect(h.runtime.cancelActive).toHaveBeenCalledOnce());
    expect(h.runtime.close).not.toHaveBeenCalled();
    h.reaped.resolve();
    await h.lease.closed;
    await h.lease.cancel({ code: 'late_cancel' });
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.runtime.cancelActive).toHaveBeenCalledOnce();
  });

  it('acknowledges cancel before waiting for physical cleanup', async () => {
    const h = harness();
    await Promise.all([h.lease.cancel({ code: 'user_cancel' }), h.lease.cancel({ code: 'user_cancel' })]);
    expect(h.runtime.close).not.toHaveBeenCalled();
    h.reaped.resolve();
    await h.lease.closed;
    expect(h.runtime.cancelActive).toHaveBeenCalledOnce();
    expect(h.runtime.close).toHaveBeenCalledOnce();
  });

  it('closes owned resources on unexpected exit and exposes the unresolved failure', async () => {
    const h = harness();
    h.reaped.resolve();
    await expect(h.lease.closed).rejects.toThrow('before terminal ACK');
    expect(h.runtime.close).toHaveBeenCalledOnce();
    expect(h.runtime.cancelActive).not.toHaveBeenCalled();
  });

  it('honors a shorter sealed grace and sanitizes arbitrary facade reason codes', async () => {
    const h = harness({ cancelGraceMs: 50n });
    const before = BigInt(Date.now());
    await h.lease.cancel({ code: 'cancel with spaces '.repeat(20) });
    const request = h.runtime.cancelActive.mock.calls[0]![1];
    expect(request.graceDeadlineAtUnixMs).toBeGreaterThan(before);
    expect(request.graceDeadlineAtUnixMs).toBeLessThanOrEqual(BigInt(Date.now()) + 50n);
    expect(request.reasonCode).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    h.reaped.resolve(); await h.lease.closed;
  });

  it('bounds graceful cancellation by the remaining attempt deadline', async () => {
    const deadlineAtUnixMs = BigInt(Date.now() + 500);
    const h = harness({ deadlineAtUnixMs });
    await h.lease.cancel({ code: 'user' });
    expect(h.runtime.cancelActive.mock.calls[0]![1].graceDeadlineAtUnixMs).toBe(deadlineAtUnixMs);
    h.reaped.resolve(); await h.lease.closed;
  });

  it('closes expired authority without sending an invalid control message', async () => {
    const h = harness({ deadlineAtUnixMs: BigInt(Date.now() - 1) });
    await expect(h.lease.cancel({ code: 'user' })).rejects.toThrow('authority expired');
    await expect(h.lease.closed).rejects.toThrow('authority expired');
    expect(h.runtime.cancelActive).not.toHaveBeenCalled();
    expect(h.runtime.close).toHaveBeenCalledOnce();
  });
});

function terminal() {
  return create(agentV1SessionStore.EngineEventRecordV1Schema, {
    body: { case: 'terminal', value: { classification: agentV1SessionStore.EngineTerminalClassificationV1.COMPLETED } },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(budget: Partial<ConstructorParameters<typeof NativeAttemptLease>[3]> = {}) {
  const terminal = deferred<agentV1SessionStore.EngineEventRecordV1>();
  const reaped = deferred<void>();
  const runtime = {
    waitForTerminal: () => terminal.promise, waitForPhysicalReap: () => reaped.promise,
    cancelActive: vi.fn<NativeAttemptLifecycle['cancelActive']>(async () => {}),
    close: vi.fn(async () => ({ processId: 1, exitCode: 0, forced: false })),
  };
  const lease = new NativeAttemptLease(runtime as NativeAttemptLifecycle, {} as ActiveAttemptAuthorityHandle, 'attempt/1', {
    deadlineAtUnixMs: BigInt(Date.now() + 60_000), cancelGraceMs: 1_000n, ...budget,
  });
  return { terminal, reaped, runtime, lease };
}
