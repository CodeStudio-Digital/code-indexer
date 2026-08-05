import { createHash, timingSafeEqual } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import type { NativeSessionStoreBridge } from './NativeHostBridgeBinding.js';

const REQUEST_DOMAIN = Buffer.from('codestudio.agent.session-store-request.v1\0');
const RESPONSE_DOMAIN = Buffer.from('codestudio.agent.session-store-response.v1\0');

export class NativeSessionStoreBridgeClient {
  #sequence = 1n;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly owner: NativeSessionStoreBridge,
    private readonly instanceId: string,
    private readonly nowUnixMs: () => bigint,
    private readonly timeoutMs: bigint,
  ) {
    if (!instanceId || timeoutMs <= 0n) throw new RangeError('native session client authority');
  }

  request(
    body: agentV1SessionStore.SessionStoreRequest['body'],
  ): Promise<agentV1SessionStore.SessionStoreResponse['body']> {
    if (this.#closed) return Promise.reject(new Error('native session client is closed'));
    const operation = this.#tail.then(() => this.#request(body));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    await this.owner.close();
  }

  async #request(
    body: agentV1SessionStore.SessionStoreRequest['body'],
  ): Promise<agentV1SessionStore.SessionStoreResponse['body']> {
    const sequence = this.#sequence;
    const sentAt = this.nowUnixMs();
    const deadline = sentAt + this.timeoutMs;
    const requestId = `request:${sequence}`;
    const request = create(agentV1SessionStore.SessionStoreRequestSchema, { body });
    const encodedRequest = toBinary(agentV1SessionStore.SessionStoreRequestSchema, request);
    const encodedFrame = toBinary(
      agentV1SessionStore.SessionStoreRequestFrameSchema,
      create(agentV1SessionStore.SessionStoreRequestFrameSchema, {
        header: create(agentV1SessionStore.SessionStoreRequestHeaderSchema, {
          protocolVersion: 1,
          bridgeInstanceId: this.instanceId,
          requestId,
          streamSeq: sequence,
          sentAtUnixMs: sentAt,
          deadlineAtUnixMs: deadline,
          requestPayloadSha256: hash(REQUEST_DOMAIN, encodedRequest),
        }),
        encodedRequest,
      }),
    );
    const observedAt = Number(sentAt);
    if (!Number.isSafeInteger(observedAt)) {
      throw new RangeError('native session clock exceeds exact JS integer range');
    }
    const encodedResponse = await this.owner.handle(encodedFrame, observedAt);
    const frame = fromBinary(
      agentV1SessionStore.SessionStoreResponseFrameSchema,
      encodedResponse,
    );
    const header = frame.header;
    if (
      !header
      || header.protocolVersion !== 1
      || header.bridgeInstanceId !== this.instanceId
      || header.requestId !== requestId
      || header.streamSeq !== sequence
      || header.completedAtUnixMs < sentAt
      || header.completedAtUnixMs > deadline
      || !sameDigest(
        header.responsePayloadSha256,
        hash(RESPONSE_DOMAIN, frame.encodedResponse),
      )
    ) throw new Error('native session response authority diverged');
    const response = fromBinary(
      agentV1SessionStore.SessionStoreResponseSchema,
      frame.encodedResponse,
    );
    if (response.body.case === 'failure') {
      throw new Error(`native session store rejected: ${response.body.value.reasonCode}`);
    }
    if (response.body.case === undefined) {
      throw new Error('native session response body is missing');
    }
    this.#sequence = sequence + 1n;
    return response.body;
  }
}

function hash(domain: Uint8Array, payload: Uint8Array): Uint8Array {
  return createHash('sha256').update(domain).update(payload).digest();
}

function sameDigest(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}
