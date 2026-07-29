import { AttemptFrameHistory } from './AttemptFrameHistory.js';
import type {
  AttemptCorrelationAuthority,
} from './AttemptCorrelationAuthority.js';
import {
  type PendingReservation,
  assertPendingReservation,
  assertReplayResponseLength,
} from './AttemptFrameCommitValidation.js';
import { validateInboundCandidate } from './AttemptFrameReceiveValidation.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';
import {
  MAX_REPLAY_WINDOW_ENTRIES,
  MAX_TRACKED_MESSAGE_IDS,
  type AttemptFrameReceiverLimits,
  receiverLimitErrorCode,
} from './AttemptFrameReceiverTypes.js';
import {
  type BoundedReplayOutcome,
  type PendingInbound,
  type ReplayedFrame,
  invalidatePending,
  inspectPending,
  inspectReplayOutcome,
  replayOutcomeMatchesBinding,
  settlePending,
} from './AttemptFrameTransaction.js';
import { pendingFromValidatedFrame } from './AttemptPendingFactory.js';
import {
  type NegotiatedReceiverSeed, consumeNegotiatedSeed,
} from './AttemptFrameSeed.js';
import {
  acceptedReplayOutcome,
  responseReplayOutcome,
} from './AttemptReplayOutcomeFactory.js';

export {
  AttemptFrameReceiverError,
  type AttemptFrameReceiverErrorCode,
} from './AttemptFrameReceiverError.js';
export type { FrameDirection } from './AttemptFrameDirection.js';
export {
  MAX_REPLAY_WINDOW_ENTRIES,
  MAX_TRACKED_MESSAGE_IDS,
  type AttemptFrameReceiverLimits,
} from './AttemptFrameReceiverTypes.js';
export type {
  BoundedReplayOutcome,
  InboundBinding,
  PendingInbound,
  ReplayedFrame,
} from './AttemptFrameTransaction.js';
export type { NegotiatedReceiverSeed } from './AttemptFrameSeed.js';
export type FrameReceiveOutcome =
  | { readonly kind: 'pending'; readonly pending: PendingInbound }
  | { readonly kind: 'replay'; readonly replay: ReplayedFrame };

export class AttemptFrameReceiver {
  readonly #seed;
  readonly #identity;
  readonly #binding = {};
  readonly #history: AttemptFrameHistory;
  #lastStreamSeq: bigint;
  #nextToken = 0n;
  #pending?: PendingReservation;
  #poisoned = false;

  constructor(
    seed: NegotiatedReceiverSeed,
    limits: AttemptFrameReceiverLimits,
    private readonly correlations: AttemptCorrelationAuthority,
  ) {
    this.#seed = consumeNegotiatedSeed(seed);
    const limitError = receiverLimitErrorCode(limits);
    if (limitError) throw new AttemptFrameReceiverError(limitError, 'invalid receiver limits');
    this.#identity = this.#seed.identity;
    this.#lastStreamSeq = this.#seed.streamWatermark;
    this.#history = new AttemptFrameHistory(
      limits.replayCapacity,
      limits.totalIdentityCapacity,
      this.#seed.bootstrapMessageId,
      limits.maxReplayBytes,
    );
  }

  beginReceive(
    encodedFrame: Uint8Array,
    clock: () => bigint,
  ): FrameReceiveOutcome {
    this.#assertHealthy();
    if (this.#pending) {
      throw new AttemptFrameReceiverError(
        'pending_inbound_active',
        'an inbound frame is still pending',
      );
    }
    try {
      const observedAtUnixMs = clock();
      return this.#beginUnpoisoned(encodedFrame, observedAtUnixMs);
    } catch (cause) {
      this.fail();
      throw cause;
    }
  }

  #beginUnpoisoned(
    encodedFrame: Uint8Array,
    observedAtUnixMs: bigint,
  ): FrameReceiveOutcome {
    const candidate = validateInboundCandidate(encodedFrame, observedAtUnixMs, {
      protocolVersion: this.#seed.protocolVersion,
      connectionId: this.#seed.connectionId,
      identity: this.#identity,
      channel: this.#seed.channel,
      direction: this.#seed.direction,
      maximumFrameBytes: this.#seed.maximumFrameBytes,
      lastStreamSeq: this.#lastStreamSeq,
      history: this.#history,
      runtimeInstanceId: this.#seed.runtimeInstanceId,
      correlations: this.correlations,
    });
    if (candidate.kind === 'replay') return candidate;
    this.#nextToken += 1n;
    const pending = pendingFromValidatedFrame(
      this.#binding,
      this.#nextToken,
      candidate.validated,
    );
    this.#pending = {
      token: this.#nextToken,
      messageId: candidate.validated.messageId,
      streamSeq: candidate.streamSeq,
      digest: candidate.digest,
      pending,
    };
    return { kind: 'pending', pending };
  }

  commit(pending: PendingInbound, outcome: BoundedReplayOutcome): void {
    this.#assertHealthy();
    try {
      const pendingState = inspectPending(pending);
      const outcomeState = inspectReplayOutcome(outcome);
      assertPendingReservation(
        this.#pending,
        pending,
        pendingState,
        this.#binding,
      );
      if (!replayOutcomeMatchesBinding(outcome, this.#binding)) {
        throw new AttemptFrameReceiverError(
          'invalid_replay_outcome',
          'replay outcome belongs to another receiver',
        );
      }
      assertReplayResponseLength(
        outcomeState.responseByteLength,
        this.#seed.maximumFrameBytes,
      );
      this.#history.commit(pendingState.messageId, {
        digest: this.#pending!.digest,
        streamSeq: pendingState.streamSeq,
        envelopeDigest: pendingState.envelopeDigest,
        outcome,
      });
      if (this.#seed.direction === 'runner_to_host') {
        this.correlations.commitInbound(
          pendingState.payloadCase,
          pendingState.replyToMessageId,
        );
      }
      settlePending(pending);
      this.#lastStreamSeq = pendingState.streamSeq;
      this.#pending = undefined;
    } catch (cause) {
      this.fail();
      throw cause;
    }
  }

  reject(pending: PendingInbound): void {
    try {
      assertPendingReservation(
        this.#pending,
        pending,
        inspectPending(pending),
        this.#binding,
      );
      settlePending(pending);
      this.#pending = undefined;
    } finally {
      this.fail();
    }
  }

  acceptedOutcome(): BoundedReplayOutcome {
    this.#assertHealthy();
    return acceptedReplayOutcome(this.#binding);
  }

  boundedResponse(bytes: Uint8Array): BoundedReplayOutcome {
    this.#assertHealthy();
    return responseReplayOutcome(
      this.#binding,
      bytes,
      this.#seed.maximumFrameBytes,
      false,
    );
  }

  sharedResponse(bytes: Uint8Array): BoundedReplayOutcome {
    this.#assertHealthy();
    return responseReplayOutcome(
      this.#binding,
      bytes,
      this.#seed.maximumFrameBytes,
      true,
    );
  }

  #assertHealthy(): void {
    if (this.#poisoned) {
      throw new AttemptFrameReceiverError('receiver_poisoned', 'receiver is poisoned');
    }
  }

  fail(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    if (this.#pending) invalidatePending(this.#pending.pending);
    this.#pending = undefined;
    this.#history.clear();
    this.correlations.poison();
  }
  get hasPending() { return this.#pending !== undefined; }
  get maximumFrameBytes() { return this.#seed.maximumFrameBytes; }
  get replayEntryCount() { return this.#history.replayEntryCount; }
  get tombstoneCount() { return this.#history.tombstoneCount; }
  get replayBytes() { return this.#history.replayBytes; }
  get streamWatermark() { return this.#lastStreamSeq; }
  get isPoisoned() { return this.#poisoned; }
}
