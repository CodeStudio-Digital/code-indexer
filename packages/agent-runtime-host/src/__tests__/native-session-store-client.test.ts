import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { NativeSessionStoreBridgeClient, NativeSessionStoreRequestError } from '../native/NativeSessionStoreBridgeClient.js';
import type { NativeSessionStoreBridge } from '../native/NativeHostBridgeBinding.js';

const query = { case: 'querySessionState', value: create(wire.QuerySessionStateSchema, { writerHandle: 'writer' }) } as const;
const makeClient = (handle: NativeSessionStoreBridge['handle']) => {
  const owner = { handle, close: vi.fn(async () => {}) } as unknown as NativeSessionStoreBridge;
  return { owner, client: new NativeSessionStoreBridgeClient(owner, 'instance', () => 1000n, 1000n) };
};

it('preserves the first ambiguous failure and never sends queued or subsequent requests', async () => {
  const failure = new Error('ACK lost after durable commit');
  const handle = vi.fn(async () => { throw failure; });
  const { owner, client } = makeClient(handle);
  const results = await Promise.allSettled([client.request(query), client.request(query)]);
  expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
  await expect(client.request(query)).rejects.toBe(failure);
  expect(handle).toHaveBeenCalledOnce();
  await client.close(); expect(owner.close).toHaveBeenCalledOnce();
});

it('continues on the next authenticated sequence after a typed domain refusal', async () => {
  const sequences: bigint[] = [];
  const { client } = makeClient(async bytes => {
    const request = fromBinary(wire.SessionStoreRequestFrameSchema, bytes).header!;
    sequences.push(request.streamSeq);
    const encodedResponse = toBinary(wire.SessionStoreResponseSchema, create(wire.SessionStoreResponseSchema, {
      body: request.streamSeq === 1n ? { case: 'failure', value: {
        code: wire.SessionStoreFailureCode.LIMIT_EXCEEDED, reasonCode: 'payload_limit', retryable: false,
      } } : { case: 'sessionState', value: { sessionId: 'session' } },
    }));
    return toBinary(wire.SessionStoreResponseFrameSchema, create(wire.SessionStoreResponseFrameSchema, {
      header: { protocolVersion: 1, bridgeInstanceId: 'instance', requestId: request.requestId,
        streamSeq: request.streamSeq, completedAtUnixMs: 1000n,
        responsePayloadSha256: createHash('sha256').update('codestudio.agent.session-store-response.v1\0').update(encodedResponse).digest() },
      encodedResponse,
    }));
  });
  await expect(client.request(query)).rejects.toBeInstanceOf(NativeSessionStoreRequestError);
  expect((await client.request(query)).case).toBe('sessionState');
  expect(sequences).toEqual([1n, 2n]); await client.close();
});
