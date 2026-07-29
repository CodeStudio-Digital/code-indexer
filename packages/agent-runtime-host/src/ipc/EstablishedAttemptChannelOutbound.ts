import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import {
  type CommittedInbound,
  type CommittedResponse,
  mintCommittedInbound,
  mintCommittedResponse,
} from './AttemptFrameReceipt.js';
import type {
  AttemptFrameReceiver,
  PendingInbound,
} from './AttemptFrameReceiver.js';
import { inspectPending } from './AttemptFrameTransaction.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import {
  type ResponseDeadlinePolicy,
  OutboundHeaderAuthority,
} from './OutboundHeaderAuthority.js';
import { sharedOutboundBytes } from './OutboundReservation.js';
import {
  type CommittedOutbound,
  mintCommittedOutbound,
} from './CommittedOutboundReceipt.js';

export class EstablishedAttemptChannelOutbound {
  constructor(
    private readonly transport: DelimitedByteChannel,
    private readonly receiver: AttemptFrameReceiver,
    private readonly sender: OutboundHeaderAuthority,
    private readonly owner: object,
    private readonly receiptBinding: object,
  ) {}

  async commitResponse(
    pending: PendingInbound,
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): Promise<CommittedResponse> {
    const inbound = inspectPending(pending);
    const inboundBinding = pending.binding();
    const outbound = this.sender.prepareResponse(
      payload,
      inbound,
      deadline,
    );
    const response = sharedOutboundBytes(outbound);
    this.receiver.commit(
      pending,
      this.receiver.sharedResponse(response),
    );
    await this.transport.send(response, this.owner);
    const committed = this.sender.commit(outbound);
    return mintCommittedResponse(
      this.receiptBinding,
      inboundBinding,
      inbound,
      committed,
    );
  }

  commitAccepted(pending: PendingInbound): CommittedInbound {
    const inbound = inspectPending(pending);
    const inboundBinding = pending.binding();
    this.receiver.commit(pending, this.receiver.acceptedOutcome());
    return mintCommittedInbound(
      this.receiptBinding,
      inboundBinding,
      inbound,
    );
  }

  async sendNew(
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): Promise<CommittedOutbound> {
    const outbound = this.sender.prepareNew(payload, deadline);
    await this.transport.send(sharedOutboundBytes(outbound), this.owner);
    return mintCommittedOutbound(
      this.receiptBinding,
      this.sender.commit(outbound),
    );
  }
}
