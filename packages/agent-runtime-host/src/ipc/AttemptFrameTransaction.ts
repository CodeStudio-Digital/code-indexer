import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ValidatedAttemptFrame } from './AttemptFrame.js';
import {
  type InboundBinding,
  mintInboundBinding,
} from './AttemptInboundBinding.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

export type { InboundBinding } from './AttemptInboundBinding.js';

interface PendingState {
  receiverBinding: object;
  token: bigint;
  messageId: string;
  streamSeq: bigint;
  payloadCase: agentV1Runtime.FramePayload['body']['case'];
  replyToMessageId?: string;
  deadlineAtUnixMs?: bigint;
  sentAtUnixMs: bigint;
  terminalPayloadSha256?: Uint8Array;
  providerOperationId?: string;
  capabilityOperationId?: string;
  capabilityToolUseId?: string;
  capabilityGrantId?: string;
  engineEventPayloadSha256?: Uint8Array;
  engineEventLocalSequence?: bigint;
  engineEventRuntimeInstanceId?: string;
  envelopeDigest: Uint8Array;
  header: agentV1Runtime.FrameHeader;
  identity: agentV1Common.AttemptIdentity;
  payload?: agentV1Runtime.FramePayload;
  payloadDigest: Uint8Array;
  inboundBinding?: InboundBinding;
}

export type PendingSnapshot = Omit<
  PendingState,
  'receiverBinding' | 'header' | 'identity' | 'payload' | 'inboundBinding'
>;

export interface PendingInbound {
  header(): agentV1Runtime.FrameHeader;
  identity(): agentV1Common.AttemptIdentity;
  binding(): InboundBinding;
  takeBodyAndDigest(): {
    body: agentV1Runtime.FramePayload['body'];
    payloadDigest: Uint8Array;
  };
}

class PendingInboundValue implements PendingInbound {
  header() {
    const state = requirePendingState(this);
    return clone(agentV1Runtime.FrameHeaderSchema, state.header);
  }
  identity() {
    const state = requirePendingState(this);
    return clone(agentV1Common.AttemptIdentitySchema, state.identity);
  }
  binding() {
    const state = requirePendingState(this);
    state.inboundBinding ??= mintInboundBinding({
      receiverBinding: state.receiverBinding,
      token: state.token,
      messageId: state.messageId,
      streamSeq: state.streamSeq,
      envelopeDigest: state.envelopeDigest,
    });
    return state.inboundBinding;
  }
  takeBodyAndDigest() {
    const state = requirePendingState(this);
    const payload = state.payload;
    if (!payload) {
      throw new AttemptFrameReceiverError(
        'pending_payload_consumed',
        'pending payload was already consumed',
      );
    }
    state.payload = undefined;
    return {
      body: payload.body,
      payloadDigest: state.payloadDigest.slice(),
    };
  }
}

const authenticPending = new WeakSet<object>();
const pendingStates = new WeakMap<object, PendingState>();

export function mintPending(
  value: Omit<PendingState, 'header' | 'identity' | 'payload'>,
  validated: ValidatedAttemptFrame,
): PendingInbound {
  const state: PendingState = {
    ...value,
    header: clone(agentV1Runtime.FrameHeaderSchema, validated.frame.header!),
    identity: clone(agentV1Common.AttemptIdentitySchema, validated.identity),
    payload: clone(agentV1Runtime.FramePayloadSchema, validated.payload),
  };
  const pending = new PendingInboundValue();
  authenticPending.add(pending);
  pendingStates.set(pending, state);
  return Object.freeze(pending);
}

export function inspectPending(pending: PendingInbound): PendingSnapshot {
  const state = requirePendingState(pending);
  return {
    token: state.token,
    messageId: state.messageId,
    streamSeq: state.streamSeq,
    payloadCase: state.payloadCase,
    replyToMessageId: state.replyToMessageId,
    deadlineAtUnixMs: state.deadlineAtUnixMs,
    sentAtUnixMs: state.sentAtUnixMs,
    terminalPayloadSha256: state.terminalPayloadSha256?.slice(),
    providerOperationId: state.providerOperationId,
    capabilityOperationId: state.capabilityOperationId,
    capabilityToolUseId: state.capabilityToolUseId,
    capabilityGrantId: state.capabilityGrantId,
    engineEventPayloadSha256: state.engineEventPayloadSha256?.slice(),
    engineEventLocalSequence: state.engineEventLocalSequence,
    engineEventRuntimeInstanceId: state.engineEventRuntimeInstanceId,
    envelopeDigest: state.envelopeDigest.slice(),
    payloadDigest: state.payloadDigest.slice(),
  };
}

export function pendingMatchesBinding(
  pending: PendingInbound,
  binding: object,
): boolean {
  if (!authenticPending.has(pending)) return false;
  return pendingStates.get(pending)?.receiverBinding === binding;
}

export function settlePending(pending: PendingInbound): void {
  requirePendingState(pending);
  pendingStates.delete(pending);
}

export function invalidatePending(pending: PendingInbound): void {
  if (authenticPending.has(pending)) pendingStates.delete(pending);
}

function requirePendingState(pending: PendingInbound): PendingState {
  if (!authenticPending.has(pending)) {
    throw new AttemptFrameReceiverError(
      'invalid_pending',
      'pending token is not authentic',
    );
  }
  const state = pendingStates.get(pending);
  if (!state) {
    throw new AttemptFrameReceiverError(
      'invalid_pending',
      'pending token is already settled',
    );
  }
  return state;
}

export type ReplayOutcomeKind = 'accepted' | 'response';
interface OutcomeState {
  receiverBinding: object;
  kind: ReplayOutcomeKind;
  response?: Uint8Array;
}

export interface ReplayOutcomeSnapshot {
  kind: ReplayOutcomeKind;
  responseByteLength?: number;
}

export interface BoundedReplayOutcome {
  readonly kind: ReplayOutcomeKind;
  responseBytes(): Uint8Array | undefined;
}

class BoundedReplayOutcomeValue implements BoundedReplayOutcome {
  constructor(private readonly state: OutcomeState) {}
  get kind() { return this.state.kind; }
  responseBytes() { return this.state.response?.slice(); }
}

const authenticOutcomes = new WeakSet<object>();
const outcomeStates = new WeakMap<object, OutcomeState>();

export function mintReplayOutcome(state: OutcomeState): BoundedReplayOutcome {
  const stored = { ...state, response: state.response?.slice() };
  return storeReplayOutcome(stored);
}

export function mintSharedReplayOutcome(
  state: OutcomeState,
): BoundedReplayOutcome {
  return storeReplayOutcome({ ...state });
}

function storeReplayOutcome(state: OutcomeState): BoundedReplayOutcome {
  const stored = state;
  const outcome = new BoundedReplayOutcomeValue(stored);
  authenticOutcomes.add(outcome);
  outcomeStates.set(outcome, stored);
  return Object.freeze(outcome);
}

export function inspectReplayOutcome(
  outcome: BoundedReplayOutcome,
): ReplayOutcomeSnapshot {
  if (!authenticOutcomes.has(outcome)) {
    throw new AttemptFrameReceiverError(
      'invalid_replay_outcome',
      'replay outcome is not authentic',
    );
  }
  const state = outcomeStates.get(outcome)!;
  return {
    kind: state.kind,
    responseByteLength: state.response?.byteLength,
  };
}

export function sharedReplayResponse(
  outcome: BoundedReplayOutcome,
): Uint8Array | undefined {
  inspectReplayOutcome(outcome);
  return outcomeStates.get(outcome)!.response;
}

export function replayOutcomeMatchesBinding(
  outcome: BoundedReplayOutcome,
  binding: object,
): boolean {
  if (!authenticOutcomes.has(outcome)) return false;
  return outcomeStates.get(outcome)!.receiverBinding === binding;
}

export interface ReplayedFrame {
  readonly messageId: string;
  readonly streamSeq: bigint;
  readonly envelopeDigest: Uint8Array;
  readonly outcome: BoundedReplayOutcome;
}
