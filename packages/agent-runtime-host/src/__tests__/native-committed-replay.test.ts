import { createHash, randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { replayNativeCommittedEvents } from '../native/NativeCommittedEventReplay.js';

function fixture() {
  const sessionId = randomUUID();
  const identity = create(agentV1Common.AttemptIdentitySchema, { sessionId, commandId: randomUUID(),
    agentRunId: randomUUID(), attemptId: randomUUID(), rootAgentRunId: randomUUID(),
    correlationId: randomUUID(), executorOwnerId: 'host', fencingEpoch: 1n });
  const record = create(wire.EngineEventRecordV1Schema, { schemaVersion: 1, identity,
    localSequence: 1n, runtimeInstanceId: 'runtime', body: { case: 'providerStarted', value: { operationId: 'provider' } } });
  const payload = toBinary(wire.EngineEventRecordV1Schema, record);
  const receipt = create(wire.CommitSessionRecordReceiptSchema, { sessionId, operationId: randomUUID(), globalSequence: 1n,
    kind: wire.SessionRecordKind.LIFECYCLE_EVENT, durability: wire.SessionDurabilityClass.DURABLE,
    payloadBytes: BigInt(payload.byteLength), payloadSha256: createHash('sha256').update(payload).digest() });
  const store = { list: vi.fn(async () => ({ records: [receipt], nextGlobalSequence: 1n, complete: true })),
    read: vi.fn(async () => payload) };
  return { sessionId, record, payload, receipt, store };
}

describe('native committed content replay', () => {
  it('uses exact receipts and does not read the next payload until the consumer asks', async () => {
    const f = fixture();
    const second = create(wire.CommitSessionRecordReceiptSchema, { ...f.receipt, globalSequence: 2n });
    f.store.list.mockResolvedValue({ records: [f.receipt, second], nextGlobalSequence: 2n, complete: true });
    const iterator = replayNativeCommittedEvents(f.store, f.sessionId);
    expect((await iterator.next()).value?.receipt.globalSequence).toBe(1n);
    expect(f.store.read).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).value?.receipt.globalSequence).toBe(2n);
    expect(f.store.read).toHaveBeenLastCalledWith(second);
    expect((await iterator.next()).done).toBe(true);
  });

  it('rejects corrupted bytes, wrong storage kind, missing sequence and foreign authority', async () => {
    for (const change of ['bytes', 'kind', 'sequence', 'session']) {
      const f = fixture();
      if (change === 'bytes') f.payload[f.payload.length - 1] ^= 1;
      if (change === 'kind') f.receipt.kind = wire.SessionRecordKind.TOOL_OUTPUT;
      if (change === 'sequence') f.receipt.globalSequence = 2n;
      if (change === 'session') f.receipt.sessionId = randomUUID();
      await expect(replayNativeCommittedEvents(f.store, f.sessionId).next()).rejects.toThrow();
    }
  });

  it('does not perform another read after cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(replayNativeCommittedEvents(f.store, f.sessionId, 0n, 100, controller.signal).next()).rejects.toThrow();
    expect(f.store.list).not.toHaveBeenCalled(); expect(f.store.read).not.toHaveBeenCalled();
  });
});
