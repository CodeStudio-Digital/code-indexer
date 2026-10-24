import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { LegacyAgentRuntimeAdapter, NativeRustAgentRuntimeAdapter, type PreparedLegacyAgentAttempt,
  type AttemptRuntimeLease, type PreparedAgentAttempt, type RuntimeRouteRecord } from '../index.js';

function fixture() {
  const authority = {
    sessionId: 'session', commandId: 'command', agentRunId: 'run', attemptId: 'attempt',
    executorOwnerId: 'worker', fencingEpoch: 1n, correlationId: 'correlation', rootAgentRunId: 'run',
    leaseExpiresAtUnixMs: 9_999_999_999_999n, deadlineAtUnixMs: 9_999_999_999_999n,
  } as PreparedAgentAttempt['authority'];
  // Adapter fixtures isolate ownership; full prepared-spec validation belongs
  // to the facade suite, before this boundary can be called by the product.
  const prepared = { authority, expectedSpecSha256: new Uint8Array(32).fill(1),
    wireSpec: create(agentV1Runtime.ResolvedAttemptSpecSchema) } as PreparedAgentAttempt;
  const route = { ...authority, runtimeGeneration: 'legacy_ts' } as unknown as RuntimeRouteRecord;
  return { prepared, route };
}

describe('LegacyAgentRuntimeAdapter ownership', () => {
  it('allows owned cleanup after execution was fenced without accepting changed identity or another launch', async () => {
    const { prepared, route } = fixture();
    let fenced = false;
    const cancel = vi.fn(async () => {});
    const assertCurrent = vi.fn(async () => { if (fenced) throw new Error('execution fenced'); });
    const assertCancellationAuthority = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ cancel, closed: new Promise<void>(() => {}) }));
    const adapter = new LegacyAgentRuntimeAdapter({ assertCurrent, assertCancellationAuthority, launch });
    await adapter.launch(prepared, route); fenced = true;
    await expect(adapter.cancel({ ...prepared.authority, fencingEpoch: 2n }, { code: 'user_cancelled' })).rejects.toThrow('authority changed');
    expect(assertCancellationAuthority).not.toHaveBeenCalled();
    await adapter.cancel(prepared.authority, { code: 'user_cancelled' });
    expect(cancel).toHaveBeenCalledOnce(); expect(assertCancellationAuthority).toHaveBeenCalledWith(prepared.authority);
    const next = { ...prepared, authority: { ...prepared.authority, attemptId: 'next' as typeof prepared.authority.attemptId } };
    await expect(adapter.launch(next, { ...route, attemptId: next.authority.attemptId })).rejects.toThrow('execution fenced');
    expect(launch).toHaveBeenCalledOnce();
  });
  it('keeps the existing active-authority requirement when no cleanup authority is supplied', async () => {
    const { prepared, route } = fixture(); let fenced = false;
    const cancel = vi.fn(async () => {});
    const adapter = new LegacyAgentRuntimeAdapter({ assertCurrent: async () => { if (fenced) throw new Error('fenced'); },
      launch: async () => ({ cancel, closed: new Promise<void>(() => {}) }) });
    await adapter.launch(prepared, route); fenced = true;
    await expect(adapter.cancel(prepared.authority, { code: 'user_cancelled' })).rejects.toThrow('fenced');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('never provisions a native process from legacy-only admission facts', async () => {
    const { prepared, route } = fixture();
    const { wireSpec: _wireSpec, ...legacy } = prepared;
    const provision = vi.fn(async () => { throw new Error('must not provision'); });
    const native = new NativeRustAgentRuntimeAdapter({ assertCurrent: async () => {}, provision });
    await expect(native.launch(legacy as unknown as PreparedLegacyAgentAttempt, { ...route, runtimeGeneration: 'rust_v1' }))
      .rejects.toThrow('native wire spec');
    expect(provision).not.toHaveBeenCalled();
  });
  it('launches once under concurrent replay and does not retry an ambiguous start', async () => {
    const { prepared, route } = fixture();
    const launch = vi.fn(async () => { throw new Error('ack lost'); });
    const adapter = new LegacyAgentRuntimeAdapter({ assertCurrent: async () => {}, launch });
    const results = await Promise.allSettled([adapter.launch(prepared, route), adapter.launch(prepared, route)]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    await expect(adapter.launch(prepared, route)).rejects.toThrow('ack lost');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('rejects changed fencing, spec and runtime without launching another worker', async () => {
    const { prepared, route } = fixture();
    const launch = vi.fn(async () => ({ cancel: async () => {}, closed: new Promise<void>(() => {}) }));
    const adapter = new LegacyAgentRuntimeAdapter({ assertCurrent: async () => {}, launch });
    await adapter.launch(prepared, route);
    await expect(adapter.launch({ ...prepared, expectedSpecSha256: new Uint8Array(32).fill(2) }, route)).rejects.toThrow('input changed');
    await expect(adapter.cancel({ ...prepared.authority, fencingEpoch: 2n }, { code: 'cancel' })).rejects.toThrow('authority changed');
    await expect(adapter.launch(prepared, { ...route, runtimeGeneration: 'rust_v1' })).rejects.toThrow('route');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('cancels a lease that arrives after cancellation exactly once', async () => {
    const { prepared, route } = fixture();
    let resolve!: (lease: AttemptRuntimeLease) => void;
    const cancel = vi.fn(async () => {});
    const launch = vi.fn(() => new Promise<AttemptRuntimeLease>(done => { resolve = done; }));
    const adapter = new LegacyAgentRuntimeAdapter({ assertCurrent: async () => {}, launch });
    const starting = adapter.launch(prepared, route);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const cancelling = adapter.cancel(prepared.authority, { code: 'user_cancel' });
    await Promise.resolve();
    resolve({ cancel, closed: new Promise<void>(() => {}) });
    await Promise.all([starting, cancelling]);
    await adapter.cancel(prepared.authority, { code: 'user_cancel' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
