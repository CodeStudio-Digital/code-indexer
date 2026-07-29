import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
import {
  type OutboundRequestFacts,
  type OutstandingRequest,
  assertInboundCorrelation,
  assertOutboundResponse,
  captureOutboundRequestFacts,
  isRunnerResponse,
} from './AttemptCorrelationValidation.js';
import { OutboundFrameError } from './OutboundFrameError.js';

type PayloadCase = agentV1Runtime.FramePayload['body']['case'];

export class AttemptCorrelationAuthority {
  readonly #outstanding = new Map<string, OutstandingRequest>();
  #poisoned = false;

  constructor(private readonly maximumOutstanding: number) {}

  captureNew(
    payload: agentV1Runtime.FramePayload,
  ): OutboundRequestFacts {
    this.#assertHealthyOutbound();
    if (this.#outstanding.size >= this.maximumOutstanding) {
      throw outboundError(
        'outbound request correlation capacity is exhausted',
      );
    }
    return captureOutboundRequestFacts(payload);
  }

  assertResponse(
    payload: agentV1Runtime.FramePayload,
    inbound: PendingSnapshot,
    responseSentAtUnixMs: bigint,
  ): void {
    this.#assertHealthyOutbound();
    assertOutboundResponse(payload, inbound, responseSentAtUnixMs);
  }

  registerNew(
    messageId: string,
    facts: OutboundRequestFacts,
    payloadDigest: Uint8Array,
    sentAtUnixMs: bigint,
  ): void {
    this.#assertHealthyOutbound();
    if (this.#outstanding.size >= this.maximumOutstanding) {
      throw outboundError(
        'outbound request correlation capacity is exhausted',
      );
    }
    this.#outstanding.set(messageId, {
      facts: cloneFacts(facts),
      payloadDigest: payloadDigest.slice(),
      sentAtUnixMs,
    });
  }

  validateInbound(
    payload: agentV1Runtime.FramePayload,
    replyToMessageId: string | undefined,
    observedAtUnixMs: bigint,
  ): void {
    this.#assertHealthyInbound();
    const request = replyToMessageId === undefined
      ? undefined
      : this.#outstanding.get(replyToMessageId);
    assertInboundCorrelation(
      payload,
      replyToMessageId,
      observedAtUnixMs,
      request,
    );
  }

  commitInbound(
    payloadCase: PayloadCase,
    replyToMessageId: string | undefined,
  ): void {
    if (!isRunnerResponse(payloadCase)) return;
    if (
      replyToMessageId === undefined
      || !this.#outstanding.delete(replyToMessageId)
    ) {
      throw new AttemptFrameReceiverError(
        'correlation_mismatch',
        'inbound response correlation is stale',
      );
    }
  }

  poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    this.#outstanding.clear();
  }

  get outstandingCount(): number {
    return this.#outstanding.size;
  }

  #assertHealthyOutbound(): void {
    if (this.#poisoned) throw outboundError('correlation authority is poisoned');
  }

  #assertHealthyInbound(): void {
    if (this.#poisoned) {
      throw new AttemptFrameReceiverError(
        'correlation_mismatch',
        'correlation authority is poisoned',
      );
    }
  }
}

function cloneFacts(facts: OutboundRequestFacts): OutboundRequestFacts {
  switch (facts.requestCase) {
    case 'prepareAttempt':
      return Object.freeze({
        requestCase: facts.requestCase,
        expectedSpecSha256: facts.expectedSpecSha256.slice(),
      });
    case 'hydrationChunk':
      return Object.freeze({
        ...facts,
        manifestPayloadSha256: facts.manifestPayloadSha256.slice(),
      });
    case 'hydrationComplete':
      return Object.freeze({
        ...facts,
        manifestPayloadSha256: facts.manifestPayloadSha256.slice(),
      });
    default:
      return facts;
  }
}

function outboundError(message: string): OutboundFrameError {
  return new OutboundFrameError('invalid_correlation', message);
}
