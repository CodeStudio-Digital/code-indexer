import { timingSafeEqual } from 'node:crypto';
import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
import {
  type DataOutboundRequestFacts,
  assertDataInboundCorrelation,
  captureDataOutboundRequestFacts,
  isDataRunnerResponse,
} from './AttemptDataCorrelationValidation.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import { OutboundFrameError } from './OutboundFrameError.js';
import {
  earliestLocalPeerTimestamp,
  latestLocalPeerTimestamp,
} from './LocalPeerClock.js';

type PayloadCase = agentV1Runtime.FramePayload['body']['case'];
type ControlOutboundRequestFacts =
  | {
    readonly requestCase: 'prepareAttempt';
    readonly expectedSpecSha256: Uint8Array;
  }
  | {
    readonly requestCase:
      | 'activateAttempt'
      | 'cancelAttempt'
      | 'fenceAttempt';
  };

export type OutboundRequestFacts =
  | ControlOutboundRequestFacts
  | DataOutboundRequestFacts;

export interface OutstandingRequest {
  readonly facts: OutboundRequestFacts;
  readonly payloadDigest: Uint8Array;
  readonly sentAtUnixMs: bigint;
}

export function captureOutboundRequestFacts(
  payload: agentV1Runtime.FramePayload,
): OutboundRequestFacts {
  const body = payload.body;
  switch (body.case) {
    case 'prepareAttempt':
      if (body.value.expectedSpecSha256.byteLength !== 32) {
        throw outboundError('PrepareAttempt expected spec digest is invalid');
      }
      return Object.freeze({
        requestCase: body.case,
        expectedSpecSha256: body.value.expectedSpecSha256.slice(),
      });
    case 'activateAttempt':
    case 'cancelAttempt':
    case 'fenceAttempt':
      return Object.freeze({ requestCase: body.case });
    default: {
      const facts = captureDataOutboundRequestFacts(payload);
      if (facts) return facts;
      throw outboundError('only host requests may be sent without reply_to');
    }
  }
}

export function assertOutboundResponse(
  payload: agentV1Runtime.FramePayload,
  inbound: PendingSnapshot,
  responseSentAtUnixMs: bigint,
): void {
  if (inbound.payloadCase === 'heartbeat' && payload.body.case === 'ack') {
    assertAckFacts(
      payload.body.value,
      inbound.messageId,
      inbound.payloadDigest,
      inbound.sentAtUnixMs,
      responseSentAtUnixMs,
      outboundError,
      timestampWithin,
    );
    return;
  }
  if (
    inbound.payloadCase === 'terminalProposal'
    && payload.body.case === 'terminalCommitted'
  ) {
    const expectedDigest = inbound.terminalPayloadSha256;
    if (
      payload.body.value.terminalProposalMessageId !== inbound.messageId
      || !sameDigest(
        payload.body.value.terminalPayloadSha256,
        expectedDigest,
      )
      || !timestampWithin(
        payload.body.value.committedAtUnixMs,
        inbound.sentAtUnixMs,
        responseSentAtUnixMs,
      )
    ) {
      throw outboundError(
        'TerminalCommitted contradicts its pending TerminalProposal',
      );
    }
    return;
  }
  throw outboundError(
    `payload ${payload.body.case ?? 'missing'} cannot respond to ${inbound.payloadCase ?? 'missing'}`,
  );
}

export function assertInboundCorrelation(
  payload: agentV1Runtime.FramePayload,
  replyToMessageId: string | undefined,
  observedAtUnixMs: bigint,
  request: OutstandingRequest | undefined,
): void {
  const body = payload.body;
  if (body.case === 'heartbeat' || body.case === 'terminalProposal') {
    if (replyToMessageId !== undefined) {
      throw inboundError(`${body.case} must not carry reply_to`);
    }
    return;
  }
  if (body.case === 'attemptPrepared') {
    if (
      request?.facts.requestCase !== 'prepareAttempt'
      || !sameDigest(
        body.value.specSha256,
        request.facts.expectedSpecSha256,
      )
      || !timestampWithin(
        body.value.readyAtUnixMs,
        request.sentAtUnixMs,
        observedAtUnixMs,
      )
    ) throw inboundError('AttemptPrepared contradicts its PrepareAttempt request');
    return;
  }
  if (body.case === 'ack') {
    const requestCase = request?.facts.requestCase;
    if (
      !request
      || requestCase === 'prepareAttempt'
      || requestCase === 'bindAttemptChannel'
      || requestCase === 'hydrationManifest'
      || requestCase === 'hydrationChunk'
      || requestCase === 'hydrationComplete'
      || replyToMessageId === undefined
    ) throw inboundError('Ack reply_to is not a compatible request');
    assertAckFacts(
      body.value,
      replyToMessageId,
      request.payloadDigest,
      request.sentAtUnixMs,
      observedAtUnixMs,
      inboundError,
      timestampWithinLocalPeer,
    );
    return;
  }
  if (assertDataInboundCorrelation(payload, observedAtUnixMs, request)) return;
}

export function isRunnerResponse(payloadCase: PayloadCase): boolean {
  return payloadCase === 'attemptPrepared'
    || payloadCase === 'ack'
    || isDataRunnerResponse(payloadCase);
}

function assertAckFacts<T extends Error>(
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

function sameDigest(
  actual: Uint8Array,
  expected: Uint8Array | undefined,
): boolean {
  return expected !== undefined
    && actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
}

function timestampWithin(actual: bigint, earliest: bigint, latest: bigint): boolean {
  return actual >= earliest && actual <= latest;
}

function timestampWithinLocalPeer(
  actual: bigint,
  earliest: bigint,
  latest: bigint,
): boolean {
  return actual >= earliestLocalPeerTimestamp(earliest)
    && actual <= latestLocalPeerTimestamp(latest);
}

function outboundError(message: string): OutboundFrameError {
  return new OutboundFrameError('invalid_correlation', message);
}

function inboundError(message: string): AttemptFrameReceiverError {
  return new AttemptFrameReceiverError('correlation_mismatch', message);
}
