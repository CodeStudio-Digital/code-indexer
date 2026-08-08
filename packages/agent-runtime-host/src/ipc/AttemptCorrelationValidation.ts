import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
import {
  type DataOutboundRequestFacts,
  assertDataInboundCorrelation,
  captureDataOutboundRequestFacts,
  isDataRunnerResponse,
} from './AttemptDataCorrelationValidation.js';
import {
  assertAckFacts,
  inboundError,
  outboundError,
  sameDigest,
  timestampAfterLocalPeerStart,
  timestampWithin,
  timestampWithinLocalPeer,
} from './AttemptCorrelationPrimitives.js';

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

export function assertOutboundEvent(
  payload: agentV1Runtime.FramePayload,
): void {
  switch (payload.body.case) {
    case 'providerTextDelta':
    case 'providerThinkingDelta':
    case 'providerToolCall':
    case 'providerUsage':
    case 'providerTerminal':
      return;
    default:
      throw outboundError('only Host provider stream events may use event disposition');
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
  if (
    inbound.payloadCase === 'providerStart'
    && payload.body.case === 'providerAccepted'
  ) {
    if (payload.body.value.operationId !== inbound.providerOperationId) {
      throw outboundError('ProviderAccepted operation contradicts its ProviderStart');
    }
    if (!sameDigest(
      payload.body.value.requestPayloadSha256,
      inbound.payloadDigest,
    )) throw outboundError('ProviderAccepted digest contradicts its ProviderStart');
    if (!timestampAfterLocalPeerStart(
      payload.body.value.acceptedAtUnixMs,
      inbound.sentAtUnixMs,
      responseSentAtUnixMs,
    )) throw outboundError(
      `ProviderAccepted timestamp ${payload.body.value.acceptedAtUnixMs}`
        + ` is outside ${inbound.sentAtUnixMs}..${responseSentAtUnixMs}`,
    );
    return;
  }
  if (
    inbound.payloadCase === 'engineEventProposal'
    && payload.body.case === 'engineEventCommitted'
  ) {
    if (
      payload.body.value.runtimeInstanceId !== inbound.engineEventRuntimeInstanceId
      || payload.body.value.localSequence !== inbound.engineEventLocalSequence
      || !sameDigest(
        payload.body.value.eventPayloadSha256,
        inbound.engineEventPayloadSha256,
      )
      || !sameDigest(
        payload.body.value.commitReceipt?.payloadSha256 ?? new Uint8Array(),
        inbound.engineEventPayloadSha256,
      )
    ) throw outboundError('EngineEventCommitted contradicts its proposal');
    return;
  }
  if (
    inbound.payloadCase === 'capabilityPrepare'
    && payload.body.case === 'capabilityUpdate'
  ) {
    if (
      payload.body.value.operationId !== inbound.capabilityOperationId
      || payload.body.value.toolUseId !== inbound.capabilityToolUseId
    ) throw outboundError('CapabilityUpdate contradicts its CapabilityPrepare');
    return;
  }
  if (
    inbound.payloadCase === 'capabilityExecute'
    && payload.body.case === 'capabilityExecutionResult'
  ) {
    if (
      payload.body.value.operationId !== inbound.capabilityOperationId
      || payload.body.value.toolUseId !== inbound.capabilityToolUseId
      || payload.body.value.grantId !== inbound.capabilityGrantId
    ) throw outboundError('CapabilityExecutionResult contradicts its execute request');
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
      || !timestampWithinLocalPeer(
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
