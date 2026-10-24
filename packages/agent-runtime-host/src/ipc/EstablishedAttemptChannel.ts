import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from './AttemptClock.js';
import {
  type CommittedInbound,
  type CommittedResponse,
  receiptMatchesInbound,
} from './AttemptFrameReceipt.js';
import {
  AttemptFrameReceiver,
  AttemptFrameReceiverError,
  type InboundBinding,
  type PendingInbound,
} from './AttemptFrameReceiver.js';
import {
  inspectPending,
  sharedReplayResponse,
} from './AttemptFrameTransaction.js';
import {
  type CommittedOutbound,
  outboundReceiptMatches,
} from './CommittedOutboundReceipt.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { EstablishedChannelState } from './EstablishedChannelState.js';
import {
  OutboundHeaderAuthority,
  type ResponseDeadlinePolicy,
} from './OutboundHeaderAuthority.js';

export type { InboundBinding, PendingInbound };
export { OutboundFrameError } from './OutboundFrameError.js';
export type { CommittedInbound, CommittedResponse };
export type { CommittedOutbound } from './CommittedOutboundReceipt.js';
export type { ResponseDeadlinePolicy } from './OutboundHeaderAuthority.js';

export type EstablishedReceiveOutcome =
  | { readonly kind: 'pending'; readonly pending: PendingInbound }
  | {
    readonly kind: 'replayed';
    readonly messageId: string;
    readonly streamSeq: bigint;
  };

const HANDOFF = {};

export class EstablishedAttemptChannel {
  nowUnixMs(): bigint { return this.state.clock.now(); }
  get remainingInboundIdentities(): number {
    return this.state.receiver.remainingIdentityCapacity;
  }

  constructor(
    handoff: object,
    private readonly state: EstablishedChannelState,
  ) {
    if (handoff !== HANDOFF) throw new TypeError('invalid established handoff');
  }

  async beginReceive(): Promise<EstablishedReceiveOutcome> {
    return this.state.runInbound(async () => {
      if (this.state.receiver.hasPending) {
        throw new AttemptFrameReceiverError(
          'pending_inbound_active',
          'an inbound frame is still pending',
        );
      }
      const encoded = await this.state.transport.receive(this.state.owner);
      if (!encoded) {
        throw new AttemptFrameReceiverError(
          'unexpected_eof',
          'established channel reached EOF',
        );
      }
      // A peer may answer as soon as the bytes reach its pipe. Ensure the
      // matching outbound request is committed before validating its reply.
      await this.state.waitForOutboundIdle();
      const outcome = this.state.receiver.beginReceive(
        encoded,
        () => this.state.clock.now(),
      );
      if (outcome.kind === 'replay') {
        const response = sharedReplayResponse(outcome.replay.outcome);
        if (response) {
          await this.state.runOutbound(
            () => this.state.transport.send(response, this.state.owner),
          );
        }
        return {
          kind: 'replayed' as const,
          messageId: outcome.replay.messageId,
          streamSeq: outcome.replay.streamSeq,
        };
      }
      const inbound = inspectPending(outcome.pending);
      this.state.armPending(inbound.deadlineAtUnixMs,
        inbound.payloadCase === 'capabilityExecute' || inbound.payloadCase === 'capabilityPrepare');
      return { kind: 'pending' as const, pending: outcome.pending };
    });
  }

  async commitResponse(
    pending: PendingInbound,
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): Promise<CommittedResponse> {
    return this.state.runExclusive(async () => {
      const receipt = await this.state.outbound.commitResponse(
        pending,
        payload,
        deadline,
      );
      this.state.clearPending();
      return receipt;
    });
  }

  commitAccepted(pending: PendingInbound): CommittedInbound {
    return this.state.runInboundSync(() => {
      const receipt = this.state.outbound.commitAccepted(pending);
      this.state.clearPending();
      return receipt;
    });
  }

  async sendNew(
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): Promise<CommittedOutbound> {
    return this.state.runOutbound(
      () => this.state.outbound.sendNew(payload, deadline),
    );
  }

  async sendEvent(
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): Promise<CommittedOutbound> {
    return this.state.runOutbound(
      () => this.state.outbound.sendEvent(payload, deadline),
    );
  }

  reject(pending: PendingInbound): void {
    this.state.runInboundSync(() => {
      this.state.receiver.reject(pending);
      throw new AttemptFrameReceiverError(
        'receiver_poisoned',
        'handler rejected pending inbound work',
      );
    });
  }

  abort(cause?: unknown): void {
    this.state.abort(cause);
  }

  tick(): void {
    this.state.tick();
  }

  get isPoisoned(): boolean {
    return this.state.isPoisoned;
  }

  receiptMatches(
    receipt: CommittedInbound,
    inbound: InboundBinding,
  ): boolean {
    return receiptMatchesInbound(
      receipt,
      inbound,
      this.state.receiptBinding,
    );
  }

  outboundReceiptMatches(receipt: CommittedOutbound): boolean {
    return outboundReceiptMatches(
      receipt,
      this.state.receiptBinding,
    );
  }
}

export function createEstablishedAttemptChannel(
  transport: DelimitedByteChannel,
  receiver: AttemptFrameReceiver,
  sender: OutboundHeaderAuthority,
  owner: object,
  clock: AuthorityClock,
  hardDeadlineAtUnixMs: bigint,
  maximumPendingMs: number,
  failureObserver?: (cause: unknown) => void,
): EstablishedAttemptChannel {
  return new EstablishedAttemptChannel(
    HANDOFF,
    new EstablishedChannelState(
      transport,
      receiver,
      sender,
      owner,
      clock,
      hardDeadlineAtUnixMs,
      maximumPendingMs,
      failureObserver,
    ),
  );
}
