import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { PendingInbound } from './AttemptFrameTransaction.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import type { ProviderDataOutboundLane } from './ProviderDataOutboundLane.js';
import type { DurableEngineEventCommitPort } from './DurableEngineEventCommitPort.js';
import type { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import { ProviderRequestTransfer } from './ProviderRequestTransfer.js';
import { HostDataChannelError } from './HostDataChannelError.js';

export class HostProviderRequestTransfer extends ProviderRequestTransfer {
  constructor(
    private readonly channel: EstablishedAttemptChannel,
    private readonly bound: HostDataBoundContext,
    private readonly lane: ProviderDataOutboundLane,
  ) { super(bound); }

  async receiveChunk(pending: PendingInbound, chunk: wire.ProviderRequestChunk, digest: Uint8Array): Promise<void> {
    this.append(chunk, pending.header().deadlineAtUnixMs);
    await this.#respond(pending, chunk.operationId, digest, 'providerRequestChunkAccepted', this.channel.nowUnixMs());
  }

  async checkpoint(
    pending: PendingInbound, start: wire.ProviderStart, digest: Uint8Array,
    gateway: ProviderGateway, committer?: DurableEngineEventCommitPort,
  ): Promise<void> {
    if (!committer?.commitProviderFrontier) throw new HostDataChannelError('provider_failure', 'checkpoint has no durable writer');
    const at = await gateway.checkpoint(start, digest, committer.commitProviderFrontier.bind(committer));
    await this.#respond(pending, start.operationId, digest, 'providerCheckpointCommitted', at);
  }

  async #respond(
    pending: PendingInbound, operationId: string, digest: Uint8Array,
    kind: 'providerRequestChunkAccepted' | 'providerCheckpointCommitted', at: bigint,
  ): Promise<void> {
    await this.lane.run(async () => {
      const binding = pending.binding();
      const receipt = await this.channel.commitResponse(pending, create(wire.FramePayloadSchema, {
        body: { case: kind, value: create(wire.ProviderAcceptedSchema, {
          identity: this.bound.identity, runtimeInstanceId: this.bound.runtimeInstanceId,
          operationId, requestPayloadSha256: digest, acceptedAtUnixMs: at,
        }) },
      }), { timeoutMs: this.bound.timeoutMs });
      if (!this.channel.receiptMatches(receipt, binding)) {
        throw new HostDataChannelError('provider_failure', 'provider request receipt is foreign');
      }
    });
  }
}
