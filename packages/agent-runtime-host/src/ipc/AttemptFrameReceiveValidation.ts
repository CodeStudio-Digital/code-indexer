import type { agentV1Common } from '@mcp/agent-runtime-contracts';
import {
  type AttemptTransportChannel,
  type ValidatedAttemptFrame,
  decodeAttemptPayload,
  validateOpaqueAttemptFrame,
} from './AttemptFrame.js';
import {
  assertPayloadDirection,
  type FrameDirection,
} from './AttemptFrameDirection.js';
import {
  AttemptFrameHistory,
} from './AttemptFrameHistory.js';
import {
  AttemptFrameReceiverError,
} from './AttemptFrameReceiverError.js';
import {
  MAX_INT64,
  MAX_UINT64,
} from './AttemptFrameReceiverTypes.js';
import type { ReplayedFrame } from './AttemptFrameTransaction.js';
import type {
  AttemptCorrelationAuthority,
} from './AttemptCorrelationAuthority.js';
import {
  validatePayloadRuntimeInstance,
} from './AttemptRuntimeIdentity.js';
import { attemptIdentityEqual } from './FrameHeaderValidation.js';

export interface ReceiveValidationContext {
  protocolVersion: number;
  connectionId: string;
  identity: agentV1Common.AttemptIdentity;
  channel: AttemptTransportChannel;
  direction: FrameDirection;
  maximumFrameBytes: number;
  lastStreamSeq: bigint;
  history: AttemptFrameHistory;
  runtimeInstanceId: string;
  correlations: AttemptCorrelationAuthority;
}

export type ValidatedInboundCandidate =
  | { kind: 'replay'; replay: ReplayedFrame }
  | {
    kind: 'fresh';
    validated: ValidatedAttemptFrame;
    digest: string;
    streamSeq: bigint;
  };

export function validateInboundCandidate(
  encodedFrame: Uint8Array,
  observedAtUnixMs: bigint,
  context: ReceiveValidationContext,
): ValidatedInboundCandidate {
  if (observedAtUnixMs <= 0n || observedAtUnixMs > MAX_INT64) {
    throw new AttemptFrameReceiverError(
      'invalid_observed_at',
      'observed timestamp must be a positive int64',
    );
  }
  const opaque = validateOpaqueAttemptFrame(
    encodedFrame,
    context.channel,
    context.maximumFrameBytes,
  );
  if (opaque.protocolVersion !== context.protocolVersion) {
    throw new AttemptFrameReceiverError('protocol_mismatch', 'frame protocol mismatch');
  }
  if (opaque.connectionId !== context.connectionId) {
    throw new AttemptFrameReceiverError('connection_mismatch', 'frame connection mismatch');
  }
  if (!attemptIdentityEqual(opaque.identity, context.identity)) {
    throw new AttemptFrameReceiverError('identity_mismatch', 'frame authority is stale');
  }
  const digest = Buffer.from(opaque.envelopeDigest).toString('hex');
  const match = context.history.classify(opaque.messageId, digest);
  if (match.kind === 'replay') return match;
  if (match.kind === 'conflict') {
    throw new AttemptFrameReceiverError(
      'message_id_conflict',
      'message ID was reused with different envelope bytes',
    );
  }
  if (match.kind === 'tombstone') {
    throw new AttemptFrameReceiverError(
      'message_id_retired',
      'message ID is retired and cannot recur',
    );
  }
  const deadline = opaque.frame.header!.deadlineAtUnixMs;
  if (deadline !== undefined && observedAtUnixMs >= deadline) {
    throw new AttemptFrameReceiverError(
      'deadline_expired',
      `frame deadline ${deadline} expired at ${observedAtUnixMs}`,
    );
  }
  if (!context.history.canTrackNew) {
    throw new AttemptFrameReceiverError(
      'identity_capacity_exhausted',
      'total message identity capacity is exhausted',
    );
  }
  if (context.lastStreamSeq === MAX_UINT64) {
    throw new AttemptFrameReceiverError('sequence_exhausted', 'stream sequence is exhausted');
  }
  const expected = context.lastStreamSeq + 1n;
  const actual = opaque.frame.header!.streamSeq;
  if (actual !== expected) {
    throw new AttemptFrameReceiverError(
      'sequence_mismatch',
      `stream sequence ${actual} does not equal expected ${expected}`,
    );
  }
  const validated = decodeAttemptPayload(opaque);
  assertPayloadDirection(
    context.direction,
    context.channel,
    validated.payload,
  );
  if (context.direction === 'runner_to_host') {
    validatePayloadRuntimeInstance(
      validated.payload,
      context.runtimeInstanceId,
    );
    context.correlations.validateInbound(
      validated.payload,
      validated.frame.header!.replyToMessageId,
      observedAtUnixMs,
    );
  }
  return {
    kind: 'fresh',
    validated,
    digest,
    streamSeq: actual,
  };
}
