export interface InboundBindingCoordinates {
  receiverBinding: object;
  token: bigint;
  messageId: string;
  streamSeq: bigint;
  envelopeDigest: Uint8Array;
}

type InboundBindingState = Omit<
  InboundBindingCoordinates,
  'envelopeDigest'
>;

export interface InboundBinding {}

class InboundBindingValue implements InboundBinding {}

const authenticInboundBindings = new WeakSet<object>();
const inboundBindingStates = new WeakMap<object, InboundBindingState>();

export function mintInboundBinding(
  value: InboundBindingCoordinates,
): InboundBinding {
  const binding = Object.freeze(new InboundBindingValue());
  authenticInboundBindings.add(binding);
  inboundBindingStates.set(binding, {
    receiverBinding: value.receiverBinding,
    token: value.token,
    messageId: value.messageId,
    streamSeq: value.streamSeq,
  });
  return binding;
}

export function inboundBindingsEqual(
  left: InboundBinding,
  right: InboundBinding,
): boolean {
  if (
    !authenticInboundBindings.has(left)
    || !authenticInboundBindings.has(right)
  ) return false;
  const leftState = inboundBindingStates.get(left)!;
  const rightState = inboundBindingStates.get(right)!;
  return (
    leftState.receiverBinding === rightState.receiverBinding
    && leftState.token === rightState.token
    && leftState.messageId === rightState.messageId
    && leftState.streamSeq === rightState.streamSeq
  );
}
