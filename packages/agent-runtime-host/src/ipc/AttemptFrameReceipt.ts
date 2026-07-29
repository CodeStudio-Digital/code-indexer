import {
  type InboundBinding,
  inboundBindingsEqual,
} from './AttemptInboundBinding.js';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
type InboundCoordinates = Pick<
  PendingSnapshot,
  'messageId' | 'streamSeq'
>;
interface InboundReceiptState {
  binding: object;
  inboundBinding: InboundBinding;
  inbound: InboundCoordinates;
  kind: 'accepted' | 'response';
  outboundMessageId?: string;
  outboundStreamSeq?: bigint;
}

export interface CommittedInbound {
  readonly kind: 'accepted' | 'response';
  inboundMessageId(): string;
  inboundStreamSeq(): bigint;
}

export interface CommittedResponse extends CommittedInbound {
  readonly kind: 'response';
  outboundMessageId(): string;
  outboundStreamSeq(): bigint;
}

class CommittedInboundValue implements CommittedInbound {
  get kind() { return receiptStates.get(this)!.kind; }
  inboundMessageId() { return receiptStates.get(this)!.inbound.messageId; }
  inboundStreamSeq() { return receiptStates.get(this)!.inbound.streamSeq; }
}

class CommittedResponseValue
  extends CommittedInboundValue
  implements CommittedResponse {
  override get kind(): 'response' { return 'response'; }
  outboundMessageId() { return receiptStates.get(this)!.outboundMessageId!; }
  outboundStreamSeq() { return receiptStates.get(this)!.outboundStreamSeq!; }
}

const authenticReceipts = new WeakSet<object>();
const receiptStates = new WeakMap<object, InboundReceiptState>();

export function mintCommittedInbound(
  binding: object,
  inboundBinding: InboundBinding,
  inbound: PendingSnapshot,
): CommittedInbound {
  const state: InboundReceiptState = {
    binding,
    inboundBinding,
    inbound: inboundCoordinates(inbound),
    kind: 'accepted',
  };
  return store(new CommittedInboundValue(), state);
}

export function mintCommittedResponse(
  binding: object,
  inboundBinding: InboundBinding,
  inbound: PendingSnapshot,
  outbound: {
    readonly messageId: string;
    readonly streamSeq: bigint;
  },
): CommittedResponse {
  const state: InboundReceiptState = {
    binding,
    inboundBinding,
    inbound: inboundCoordinates(inbound),
    kind: 'response',
    outboundMessageId: outbound.messageId,
    outboundStreamSeq: outbound.streamSeq,
  };
  return store(new CommittedResponseValue(), state);
}

function inboundCoordinates(
  inbound: PendingSnapshot,
): InboundCoordinates {
  return {
    messageId: inbound.messageId,
    streamSeq: inbound.streamSeq,
  };
}

export function receiptMatchesInbound(
  receipt: CommittedInbound,
  inbound: InboundBinding,
  binding: object,
): boolean {
  return (
    authenticReceipts.has(receipt)
    && receiptStates.get(receipt)!.binding === binding
    && inboundBindingsEqual(
      receiptStates.get(receipt)!.inboundBinding,
      inbound,
    )
  );
}

function store<T extends CommittedInbound>(
  receipt: T,
  state: InboundReceiptState,
): T {
  authenticReceipts.add(receipt);
  receiptStates.set(receipt, state);
  return Object.freeze(receipt);
}
