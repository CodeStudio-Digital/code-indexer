import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type {
  OutboundRequestFacts,
} from './AttemptCorrelationValidation.js';
import { OutboundFrameError } from './OutboundFrameError.js';

export type OutboundDisposition = 'bootstrap' | 'new' | 'event' | 'response';

export interface OutboundSnapshot {
  readonly streamSeq: bigint;
  readonly messageId: string;
  readonly payloadCase: agentV1Runtime.FramePayload['body']['case'];
  readonly disposition: OutboundDisposition;
  readonly payloadDigest: Uint8Array;
  readonly sentAtUnixMs: bigint;
  readonly requestFacts?: OutboundRequestFacts;
}

interface ReservationState extends OutboundSnapshot {
  readonly encoded: Uint8Array;
}

export interface PendingOutbound {}

class PendingOutboundValue implements PendingOutbound {}

const authenticOutbound = new WeakSet<object>();
const outboundStates = new WeakMap<object, ReservationState>();

export function mintOutboundReservation(
  state: ReservationState,
): PendingOutbound {
  const pending = Object.freeze(new PendingOutboundValue());
  authenticOutbound.add(pending);
  outboundStates.set(pending, state);
  return pending;
}

export function inspectOutbound(
  pending: PendingOutbound,
): OutboundSnapshot {
  const state = requireState(pending);
  return {
    streamSeq: state.streamSeq,
    messageId: state.messageId,
    payloadCase: state.payloadCase,
    disposition: state.disposition,
    payloadDigest: state.payloadDigest.slice(),
    sentAtUnixMs: state.sentAtUnixMs,
    requestFacts: cloneRequestFacts(state.requestFacts),
  };
}

export function consumeOutbound(
  pending: PendingOutbound,
): OutboundSnapshot {
  const snapshot = inspectOutbound(pending);
  outboundStates.delete(pending);
  return snapshot;
}

export function invalidateOutbound(pending: PendingOutbound): void {
  if (authenticOutbound.has(pending)) outboundStates.delete(pending);
}

export function sharedOutboundBytes(
  pending: PendingOutbound,
): Uint8Array {
  return requireState(pending).encoded;
}

function requireState(pending: PendingOutbound): ReservationState {
  if (!authenticOutbound.has(pending)) {
    throw invalidReservation('outbound reservation is not authentic');
  }
  const state = outboundStates.get(pending);
  if (!state) throw invalidReservation('outbound reservation is stale');
  return state;
}

function invalidReservation(message: string): OutboundFrameError {
  return new OutboundFrameError('invalid_outbound_authority', message);
}

function cloneRequestFacts(
  facts: OutboundRequestFacts | undefined,
): OutboundRequestFacts | undefined {
  if (!facts) return;
  switch (facts.requestCase) {
    case 'prepareAttempt':
      return Object.freeze({
        requestCase: facts.requestCase,
        expectedSpecSha256: facts.expectedSpecSha256.slice(),
      });
    case 'hydrationChunk':
    case 'hydrationComplete':
      return Object.freeze({
        ...facts,
        manifestPayloadSha256: facts.manifestPayloadSha256.slice(),
      });
    default:
      return facts;
  }
}
