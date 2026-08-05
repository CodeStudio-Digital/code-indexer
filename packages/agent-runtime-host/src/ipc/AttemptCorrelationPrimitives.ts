import { timingSafeEqual } from 'node:crypto';
import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import { OutboundFrameError } from './OutboundFrameError.js';
import {
  earliestLocalPeerTimestamp,
  latestLocalPeerTimestamp,
} from './LocalPeerClock.js';

export function assertAckFacts<T extends Error>(
  ack: agentV1Runtime.Ack,
  expectedMessageId: string,
  expectedDigest: Uint8Array,
  earliestAtUnixMs: bigint,
  latestAtUnixMs: bigint,
  error: (message: string) => T,
  timestampValidator: (
    actual: bigint,
    earliest: bigint,
    latest: bigint,
  ) => boolean,
): void {
  if (
    ack.acknowledgedMessageId !== expectedMessageId
    || !sameDigest(ack.acknowledgedPayloadSha256, expectedDigest)
    || !timestampValidator(
      ack.acknowledgedAtUnixMs,
      earliestAtUnixMs,
      latestAtUnixMs,
    )
  ) throw error('Ack does not authenticate its correlated message');
}

export function sameDigest(
  actual: Uint8Array,
  expected: Uint8Array | undefined,
): boolean {
  return expected !== undefined
    && actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}

export function timestampWithin(
  actual: bigint,
  earliest: bigint,
  latest: bigint,
): boolean {
  return actual >= earliest && actual <= latest;
}

export function timestampWithinLocalPeer(
  actual: bigint,
  earliest: bigint,
  latest: bigint,
): boolean {
  return actual >= earliestLocalPeerTimestamp(earliest)
    && actual <= latestLocalPeerTimestamp(latest);
}

export function timestampAfterLocalPeerStart(
  actual: bigint,
  remoteEarliest: bigint,
  localLatest: bigint,
): boolean {
  return actual >= earliestLocalPeerTimestamp(remoteEarliest)
    && actual <= localLatest;
}

export function outboundError(message: string): OutboundFrameError {
  return new OutboundFrameError('invalid_correlation', message);
}

export function inboundError(message: string): AttemptFrameReceiverError {
  return new AttemptFrameReceiverError('correlation_mismatch', message);
}
