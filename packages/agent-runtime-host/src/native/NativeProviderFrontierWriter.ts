import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1Runtime, agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { OwnedProviderFrontierEncoder, sha256 } from './ProviderFrontierCodec.js';
import type { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';
import { commitContextChapters } from './NativeContextChapters.js';

export class NativeProviderFrontierWriter {
  private readonly encoder = new OwnedProviderFrontierEncoder();
  private count = 0;
  private failed = false;
  private active = false;
  constructor(private readonly client: NativeSessionStoreBridgeClient,
    private readonly writerHandle: string, private readonly sessionId: string,
    private readonly authority: wire.SessionStoreAuthority) {}

  async commit(start: agentV1Runtime.ProviderStart, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.failed || this.active || start.identity?.sessionId !== this.sessionId) {
      throw new Error('provider frontier writer authority unavailable');
    }
    this.active = true;
    const attemptId = start.identity.attemptId;
    try {
      start = await commitContextChapters(this.client, this.writerHandle, this.authority, this.sessionId, start, signal);
      const payload = this.encoder.encode(start, this.count % 32 === 0);
      const operationId = frontierOperationId(attemptId, start.operationId);
      const body = await this.client.request({ case: 'commitSessionRecord', value: create(wire.CommitSessionRecordSchema, {
        writerHandle: this.writerHandle, authority: this.authority, operationId,
        kind: wire.SessionRecordKind.CHECKPOINT, durability: wire.SessionDurabilityClass.AUTHORITATIVE,
        encodedPayload: payload, expectedPayloadSha256: sha256(payload),
      }) });
      if (body.case !== 'commitSessionRecordReceipt' || body.value.sessionId !== this.sessionId
        || body.value.operationId !== operationId || body.value.kind !== wire.SessionRecordKind.CHECKPOINT
        || body.value.durability !== wire.SessionDurabilityClass.AUTHORITATIVE
        || body.value.globalSequence <= 0n || body.value.payloadBytes !== BigInt(payload.length)
        || !Buffer.from(body.value.payloadSha256).equals(sha256(payload))
        || body.value.authority?.storageGeneration !== this.authority.storageGeneration
        || body.value.authority?.leaseEpoch !== this.authority.leaseEpoch
        || body.value.authority?.writerId !== this.authority.writerId) {
        throw new Error('provider frontier commit receipt diverged');
      }
      this.count += 1;
      signal.throwIfAborted();
    } catch (error) {
      // An ACK loss must not cause a different delta to reuse the same id.
      this.failed = true;
      throw error;
    } finally { this.active = false; }
  }
}

function frontierOperationId(attemptId: string, operationId: string): string {
  const bytes = createHash('sha256').update('codestudio.agent.provider-frontier.v1\0')
    .update(attemptId).update('\0').update(operationId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
