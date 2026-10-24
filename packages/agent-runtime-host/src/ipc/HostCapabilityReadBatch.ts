import { create } from '@bufbuild/protobuf';
import { agentV1Capability, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { CapabilityGateway } from '../capability-gateway/CapabilityGateway.js';
import type { EstablishedAttemptChannel, PendingInbound } from './EstablishedAttemptChannel.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import type { ProviderDataOutboundLane } from './ProviderDataOutboundLane.js';
import { HostDataChannelError } from './HostDataChannelError.js';

/** One bounded read window. Physical frame ownership is released by its ACK;
 * each completion then shares the existing ordered outbound lane with commits. */
export class HostCapabilityReadBatch {
  readonly #seen = new Set<string>();
  #active = false;
  constructor(private readonly channel: EstablishedAttemptChannel, private readonly context: HostDataBoundContext,
    private readonly lane: ProviderDataOutboundLane, private readonly gateway: CapabilityGateway) {}

  assertIdle() { if (this.#active) throw failure('another operation crossed an active read batch'); }

  async start(pending: PendingInbound, request: agentV1Capability.CapabilityReadBatchExecute): Promise<{ settled: Promise<void> }> {
    this.assertIdle();
    if (pending.header().replyToMessageId !== undefined) throw failure('read batch execute must be a new request');
    if (this.#seen.has(request.batchId) || this.#seen.size >= 100_000) throw failure('read batch identity replay or capacity exceeded');
    const batch = await this.gateway.validateReadBatch(request);
    this.#seen.add(batch.batchId); this.#active = true;
    await this.lane.run(async () => {
      const binding = pending.binding();
      const receipt = await this.channel.commitResponse(pending, create(agentV1Runtime.FramePayloadSchema, {
        body: { case: 'capabilityReadBatchAccepted', value: create(agentV1Capability.CapabilityReadBatchAcceptedSchema, {
          identity: this.context.identity, runtimeInstanceId: this.context.runtimeInstanceId, batchId: batch.batchId,
        }) },
      }), { timeoutMs: this.context.timeoutMs });
      if (!this.channel.receiptMatches(receipt, binding)) throw failure('read batch acceptance receipt is foreign');
    });
    const operations = batch.members.map(async (member) => {
      const result = await this.gateway.execute(member);
      await this.lane.run(async () => {
        const receipt = await this.channel.sendEvent(create(agentV1Runtime.FramePayloadSchema, {
          body: { case: 'capabilityReadBatchResult', value: create(agentV1Capability.CapabilityReadBatchResultSchema, {
            identity: this.context.identity, runtimeInstanceId: this.context.runtimeInstanceId, batchId: batch.batchId, result,
          }) },
        }), { timeoutMs: this.context.timeoutMs });
        if (!this.channel.outboundReceiptMatches(receipt)) throw failure('read batch result receipt is foreign');
      });
    });
    const settled = Promise.allSettled(operations).then((results) => {
      this.#active = false;
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    });
    return { settled };
  }
}
function failure(message: string) { return new HostDataChannelError('provider_failure', message); }
