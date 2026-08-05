import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { PendingInbound } from './AttemptFrameReceiver.js';
import type { DurableEngineEventCommitPort } from './DurableEngineEventCommitPort.js';
import {
  validateEngineEventProposal,
  validateEngineEventReceipt,
} from './EngineEventCommitValidation.js';
import type { EstablishedAttemptChannel } from './EstablishedAttemptChannel.js';
import type { HostDataBoundContext } from './HostDataAttemptChannelValidation.js';
import { HostDataChannelError } from './HostDataChannelError.js';
import type { ProviderDataOutboundLane } from './ProviderDataOutboundLane.js';

export async function commitEngineEventProposal(
  channel: EstablishedAttemptChannel,
  pending: PendingInbound,
  proposal: agentV1Runtime.EngineEventProposal,
  context: HostDataBoundContext,
  lane: ProviderDataOutboundLane,
  committer: DurableEngineEventCommitPort,
): Promise<void> {
  const request = validateEngineEventProposal(proposal, context);
  await lane.run(async () => {
    const receipt = validateEngineEventReceipt(
      await committer.commit(request),
      request,
    );
    const binding = pending.binding();
    const response = create(agentV1Runtime.FramePayloadSchema, {
      body: {
        case: 'engineEventCommitted',
        value: create(agentV1Runtime.EngineEventCommittedSchema, {
          identity: context.identity,
          runtimeInstanceId: context.runtimeInstanceId,
          localSequence: request.record.localSequence,
          eventPayloadSha256: request.expectedPayloadSha256,
          commitReceipt: receipt,
        }),
      },
    });
    const committed = await channel.commitResponse(
      pending,
      response,
      { timeoutMs: context.timeoutMs },
    );
    if (!channel.receiptMatches(committed, binding)) {
      throw new HostDataChannelError(
        'provider_failure',
        'EngineEventCommitted receipt is foreign',
      );
    }
  });
}
