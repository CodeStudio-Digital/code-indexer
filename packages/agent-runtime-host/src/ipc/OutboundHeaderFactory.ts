import { create } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { AuthorityClock } from './AttemptClock.js';
import { OutboundFrameError } from './OutboundFrameError.js';
import type { ResponseDeadlinePolicy } from './OutboundAuthorityTypes.js';
import type { FrameDirection } from './AttemptFrameDirection.js';
import {
  type AttemptTransportChannel,
  encodeAttemptFrame,
} from './AttemptFrame.js';

const MAX_INT64 = (1n << 63n) - 1n;

export interface OutboundHeaderContext {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly identity: agentV1Common.AttemptIdentity;
  readonly channel: AttemptTransportChannel;
}

export function createOutboundHeader(
  context: OutboundHeaderContext,
  coordinates: {
    streamSeq: bigint;
    messageId: string;
    replyToMessageId?: string;
    sentAtUnixMs: bigint;
    deadlineAtUnixMs: bigint;
  },
): agentV1Runtime.FrameHeader {
  const identity = context.identity;
  return create(agentV1Runtime.FrameHeaderSchema, {
    protocolVersion: context.protocolVersion,
    connectionId: context.connectionId,
    messageId: coordinates.messageId,
    replyToMessageId: coordinates.replyToMessageId,
    sessionId: identity.sessionId,
    commandId: identity.commandId,
    agentRunId: identity.agentRunId,
    attemptId: identity.attemptId,
    executorOwnerId: identity.executorOwnerId,
    fencingEpoch: identity.fencingEpoch,
    correlationId: identity.correlationId,
    streamSeq: coordinates.streamSeq,
    sentAtUnixMs: coordinates.sentAtUnixMs,
    deadlineAtUnixMs: coordinates.deadlineAtUnixMs,
    rootAgentRunId: identity.rootAgentRunId,
    ownerAgentRunId: identity.ownerAgentRunId,
    parentAgentRunId: identity.parentAgentRunId,
  });
}

export function encodeOutboundFrame(
  context: OutboundHeaderContext,
  coordinates: Parameters<typeof createOutboundHeader>[1],
  payload: agentV1Runtime.FramePayload,
  maximumFrameBytes: number,
): { encoded: Uint8Array; payloadDigest: Uint8Array } {
  let payloadDigest: Uint8Array | undefined;
  const encoded = encodeAttemptFrame(
    createOutboundHeader(context, coordinates),
    context.channel,
    payload,
    maximumFrameBytes,
    (digest) => {
      payloadDigest = digest;
    },
  );
  return { encoded, payloadDigest: payloadDigest! };
}

export function resolveOutboundDeadline(
  clock: AuthorityClock,
  hardDeadlineAtUnixMs: bigint,
  maximumResponseTimeoutMs: number,
  policy: ResponseDeadlinePolicy,
): { sentAtUnixMs: bigint; deadlineAtUnixMs: bigint } {
  if (
    !Number.isSafeInteger(policy.timeoutMs)
    || policy.timeoutMs <= 0
    || policy.timeoutMs > maximumResponseTimeoutMs
  ) {
    throw new OutboundFrameError(
      'invalid_deadline',
      'outbound timeout is outside the launch authority',
    );
  }
  const sentAtUnixMs = sampleBeforeHardDeadline(
    clock,
    hardDeadlineAtUnixMs,
  );
  const timeout = BigInt(policy.timeoutMs);
  if (sentAtUnixMs > MAX_INT64 - timeout) {
    throw new OutboundFrameError(
      'invalid_deadline',
      'outbound deadline overflows int64',
    );
  }
  const requested = sentAtUnixMs + timeout;
  return {
    sentAtUnixMs,
    deadlineAtUnixMs: requested < hardDeadlineAtUnixMs
      ? requested
      : hardDeadlineAtUnixMs,
  };
}

export function sampleBeforeHardDeadline(
  clock: AuthorityClock,
  hardDeadlineAtUnixMs: bigint,
): bigint {
  const now = clock.now();
  if (now >= hardDeadlineAtUnixMs) {
    throw new OutboundFrameError(
      'hard_deadline_expired',
      'launch hard deadline has expired',
    );
  }
  return now;
}

export function narrowedFrameMaximum(
  current: number,
  maximum: number,
  hasPending: boolean,
): number {
  if (
    hasPending
    || !Number.isInteger(maximum)
    || maximum <= 0
    || maximum > current
  ) {
    throw new OutboundFrameError(
      'invalid_outbound_authority',
      'outbound maximum may only be narrowed without a reservation',
    );
  }
  return maximum;
}

export function assertBootstrapHostHello(
  channel: AttemptTransportChannel,
  direction: FrameDirection,
  committedStreamSeq: bigint,
  payloadCase: agentV1Runtime.FramePayload['body']['case'],
): void {
  if (
    committedStreamSeq !== 0n
    || channel !== agentV1Runtime.TransportChannel.CONTROL
    || payloadCase !== 'hostHello'
    || direction !== 'host_to_runner'
  ) {
    throw new OutboundFrameError(
      'wrong_bootstrap_payload',
      'only HostHello may reserve the first host frame',
    );
  }
}
