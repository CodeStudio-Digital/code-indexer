import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime, agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { NativeProviderFrontierWriter } from '../native/NativeProviderFrontierWriter.js';
import type { NativeSessionStoreBridgeClient } from '../native/NativeSessionStoreBridgeClient.js';
import { identity } from './attempt-channel-support.js';

describe('native provider frontier writer failure boundaries', () => {
  it.each(['ENOSPC', 'ACK lost after commit'])('never reissues an ambiguous frontier after %s', async (reason) => {
    const request = vi.fn(async () => { throw new Error(reason); });
    const writer = new NativeProviderFrontierWriter({ request } as unknown as NativeSessionStoreBridgeClient,
      'writer', identity().sessionId, authority());
    await expect(writer.commit(start(0), new AbortController().signal)).rejects.toThrow(reason);
    await expect(writer.commit(start(0), new AbortController().signal)).rejects.toThrow('unavailable');
    expect(request).toHaveBeenCalledOnce();
  });

  it('writes periodic full checkpoints and stops before IO when already cancelled', async () => {
    const payloads: Uint8Array[] = [];
    const request = vi.fn(async (body: agentV1SessionStore.SessionStoreRequest['body']) => {
      if (body.case !== 'commitSessionRecord') throw new Error('unexpected request');
      const value = body.value;
      payloads.push(value.encodedPayload);
      return { case: 'commitSessionRecordReceipt', value: create(agentV1SessionStore.CommitSessionRecordReceiptSchema, {
        sessionId: identity().sessionId, operationId: value.operationId, authority: authority(),
        kind: value.kind, durability: value.durability, globalSequence: BigInt(payloads.length),
        payloadBytes: BigInt(value.encodedPayload.length), payloadSha256: value.expectedPayloadSha256,
      }) };
    });
    const writer = new NativeProviderFrontierWriter({ request } as unknown as NativeSessionStoreBridgeClient,
      'writer', identity().sessionId, authority());
    for (let index = 0; index < 33; index++) await writer.commit(start(index), new AbortController().signal);
    const records = payloads.map((payload) => fromBinary(agentV1Runtime.ProviderFrontierRecordV1Schema, payload));
    expect(records.filter((record) => !record.baseOperationId)).toHaveLength(2);
    expect(records[1]?.retainedMessageCount).toBe(1n);
    expect(records[32]?.frontier?.context?.messages).toHaveLength(33);
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    await expect(writer.commit(start(33), abort.signal)).rejects.toThrow('cancelled');
    expect(request).toHaveBeenCalledTimes(33);
  });
});

function authority() {
  return create(agentV1SessionStore.SessionStoreAuthoritySchema, {
    storageGeneration: agentV1SessionStore.StorageGeneration.RUST_FS_V1,
    leaseEpoch: 1n, writerId: 'writer',
  });
}
function start(index: number) {
  return create(agentV1Runtime.ProviderStartSchema, { identity: identity(), operationId: `provider/${index}`,
    binding: { effectiveProvider: 'test', effectiveModel: 'test' },
    messages: Array.from({ length: index + 1 }, (_, i) => create(agentV1Runtime.ProviderMessageSchema, {
      role: agentV1Runtime.ProviderMessageRole.USER, content: [{ body: { case: 'text',
        value: { body: { case: 'inlineUtf8', value: `message/${i}` } } } }],
    })),
  });
}
