import type { OutboundSnapshot } from './OutboundReservation.js';

type OutboundCoordinates = Pick<
  OutboundSnapshot,
  'messageId' | 'streamSeq'
>;

interface ReceiptState {
  readonly binding: object;
  readonly outbound: OutboundCoordinates;
}

export interface CommittedOutbound {
  outboundMessageId(): string;
  outboundStreamSeq(): bigint;
}

class CommittedOutboundValue implements CommittedOutbound {
  outboundMessageId() {
    return receiptStates.get(this)!.outbound.messageId;
  }
  outboundStreamSeq() {
    return receiptStates.get(this)!.outbound.streamSeq;
  }
}

const authenticReceipts = new WeakSet<object>();
const receiptStates = new WeakMap<object, ReceiptState>();

export function mintCommittedOutbound(
  binding: object,
  outbound: OutboundSnapshot,
): CommittedOutbound {
  const receipt = Object.freeze(new CommittedOutboundValue());
  authenticReceipts.add(receipt);
  receiptStates.set(receipt, {
    binding,
    outbound: {
      messageId: outbound.messageId,
      streamSeq: outbound.streamSeq,
    },
  });
  return receipt;
}

export function outboundReceiptMatches(
  receipt: CommittedOutbound,
  binding: object,
): boolean {
  return (
    authenticReceipts.has(receipt)
    && receiptStates.get(receipt)?.binding === binding
  );
}
