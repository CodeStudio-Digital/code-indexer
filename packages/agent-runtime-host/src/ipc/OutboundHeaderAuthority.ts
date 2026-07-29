import { randomUUID } from 'node:crypto';
import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type {
  OutboundRequestFacts,
} from './AttemptCorrelationValidation.js';
import { assertPayloadDirection } from './AttemptFrameDirection.js';
import { OutboundFrameError } from './OutboundFrameError.js';
import {
  assertBootstrapHostHello,
  encodeOutboundFrame,
  narrowedFrameMaximum,
  resolveOutboundDeadline,
  sampleBeforeHardDeadline,
} from './OutboundHeaderFactory.js';
import {
  type OutboundDisposition,
  type OutboundSnapshot,
  type PendingOutbound,
  consumeOutbound,
  inspectOutbound,
  invalidateOutbound,
  mintOutboundReservation,
} from './OutboundReservation.js';
import type { PendingSnapshot } from './AttemptFrameTransaction.js';
import type {
  OutboundAuthorityOptions,
  OutboundAuthorityState,
  ResponseDeadlinePolicy,
} from './OutboundAuthorityTypes.js';

const MAX_UINT64 = (1n << 64n) - 1n;

export type { ResponseDeadlinePolicy } from './OutboundAuthorityTypes.js';

export class OutboundHeaderAuthority {
  #state?: OutboundAuthorityState;
  #pending?: PendingOutbound;
  #poisoned = false;

  constructor(options: OutboundAuthorityOptions) {
    this.#state = {
      ...options,
      identity: clone(agentV1Common.AttemptIdentitySchema, options.identity),
      senderId: randomUUID(),
    };
  }

  prepareResponse(
    payload: agentV1Runtime.FramePayload,
    inbound: PendingSnapshot,
    deadline: ResponseDeadlinePolicy,
  ): PendingOutbound {
    const state = this.#requireState();
    assertPayloadDirection(
      state.direction,
      state.channel,
      payload,
    );
    const coordinates = this.#deadline(deadline);
    state.correlations.assertResponse(
      payload,
      inbound,
      coordinates.sentAtUnixMs,
    );
    return this.#prepare(
      payload,
      'response',
      inbound.messageId,
      coordinates.sentAtUnixMs,
      coordinates.deadlineAtUnixMs,
    );
  }

  prepareNew(
    payload: agentV1Runtime.FramePayload,
    deadline: ResponseDeadlinePolicy,
  ): PendingOutbound {
    const state = this.#requireState();
    assertPayloadDirection(
      state.direction,
      state.channel,
      payload,
    );
    const requestFacts = state.correlations.captureNew(payload);
    const coordinates = this.#deadline(deadline);
    return this.#prepare(
      payload,
      'new',
      undefined,
      coordinates.sentAtUnixMs,
      coordinates.deadlineAtUnixMs,
      requestFacts,
    );
  }

  prepareBootstrapHostHello(
    payload: agentV1Runtime.FramePayload,
  ): PendingOutbound {
    const state = this.#requireState();
    assertBootstrapHostHello(
      state.channel,
      state.direction,
      state.committedStreamSeq,
      payload.body.case,
    );
    const sentAtUnixMs = sampleBeforeHardDeadline(
      state.clock,
      state.hardDeadlineAtUnixMs,
    );
    return this.#prepare(
      payload,
      'bootstrap',
      undefined,
      sentAtUnixMs,
      state.hardDeadlineAtUnixMs,
    );
  }

  commit(pending: PendingOutbound): OutboundSnapshot {
    this.validate(pending);
    const state = this.#requireState();
    const snapshot = consumeOutbound(pending);
    if (snapshot.disposition === 'new') {
      if (!snapshot.requestFacts) {
        throw new OutboundFrameError(
          'invalid_outbound_authority',
          'new request reservation lacks correlation facts',
        );
      }
      state.correlations.registerNew(
        snapshot.messageId,
        snapshot.requestFacts,
        snapshot.payloadDigest,
        snapshot.sentAtUnixMs,
      );
    }
    state.committedStreamSeq = snapshot.streamSeq;
    this.#pending = undefined;
    return snapshot;
  }

  validate(pending: PendingOutbound): void {
    this.#requireState();
    if (this.#pending !== pending) {
      throw new OutboundFrameError(
        'invalid_outbound_authority',
        'outbound reservation is foreign or stale',
      );
    }
    inspectOutbound(pending);
  }

  narrowMaximumFrameBytes(maximum: number): void {
    const state = this.#requireState();
    state.maximumFrameBytes = narrowedFrameMaximum(
      state.maximumFrameBytes,
      maximum,
      this.#pending !== undefined,
    );
  }

  poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    if (this.#pending) invalidateOutbound(this.#pending);
    this.#pending = undefined;
    this.#state?.correlations.poison();
    this.#state = undefined;
  }

  get isPoisoned(): boolean {
    return this.#poisoned;
  }

  #prepare(
    payload: agentV1Runtime.FramePayload,
    disposition: OutboundDisposition,
    replyToMessageId: string | undefined,
    sentAtUnixMs: bigint,
    deadlineAtUnixMs: bigint,
    requestFacts?: OutboundRequestFacts,
  ): PendingOutbound {
    const state = this.#requireState();
    if (this.#pending) {
      throw new OutboundFrameError(
        'pending_outbound_active',
        'an outbound reservation is already active',
      );
    }
    const streamSeq = state.committedStreamSeq + 1n;
    if (streamSeq > MAX_UINT64) {
      throw new OutboundFrameError('sequence_exhausted', 'outbound sequence exhausted');
    }
    const messageId = `outbound:${state.senderId}:${streamSeq}`;
    const encodedFrame = encodeOutboundFrame(
      state,
      {
        streamSeq,
        messageId,
        replyToMessageId,
        sentAtUnixMs,
        deadlineAtUnixMs,
      },
      payload,
      state.maximumFrameBytes,
    );
    const pending = mintOutboundReservation({
      streamSeq,
      messageId,
      payloadCase: payload.body.case,
      disposition,
      payloadDigest: encodedFrame.payloadDigest,
      sentAtUnixMs,
      requestFacts,
      encoded: encodedFrame.encoded,
    });
    this.#pending = pending;
    return pending;
  }

  #deadline(policy: ResponseDeadlinePolicy): {
    sentAtUnixMs: bigint;
    deadlineAtUnixMs: bigint;
  } {
    const state = this.#requireState();
    return resolveOutboundDeadline(
      state.clock,
      state.hardDeadlineAtUnixMs,
      state.maximumResponseTimeoutMs,
      policy,
    );
  }

  #requireState(): OutboundAuthorityState {
    if (this.#poisoned || !this.#state) {
      throw new OutboundFrameError(
        'sender_poisoned',
        'outbound authority is poisoned',
      );
    }
    return this.#state;
  }
}
