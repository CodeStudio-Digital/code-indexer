import { clone } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { validateManagementFrame } from './ManagementFrame.js';
import {
  HostSupervisorReplayHistory,
} from './HostSupervisorReplayHistory.js';
import {
  snapshotFactHandoff,
  validateSupervisorEnvelopeHeader,
  validateSupervisorFact,
} from './HostSupervisorFactValidation.js';
import {
  managementEnvelopeFingerprint,
  normalizeSupervisorFactFailure,
} from './HostSupervisorAcknowledgement.js';
import type {
  PendingSupervisorFact,
  SupervisorFactReceiveOutcome,
} from './HostSupervisorFactChannelTypes.js';
import { HostSupervisorAckAuthority } from './HostSupervisorAckAuthority.js';
import {
  assertSupervisorAckCapacity,
} from './HostSupervisorAckPreflight.js';
import {
  validateSupervisorSequence,
} from './HostSupervisorSequenceValidation.js';
import { scrubManagementPayload } from './ManagementPayloadScrub.js';

export class HostSupervisorFactChannel {
  readonly #history: HostSupervisorReplayHistory;
  readonly #handoff;
  readonly #nowUnixMs;
  readonly #ackAuthority: HostSupervisorAckAuthority;
  #lastInboundStreamSeq: bigint;
  #pending?: PendingSupervisorFact;
  #failure?: HostSupervisorFactError;

  constructor(
    private readonly transport: DelimitedByteChannel,
    private readonly owner: object,
    handoff: HostSupervisorFactHandoff,
    nowUnixMs: () => bigint,
  ) {
    try {
      this.#handoff = snapshotFactHandoff(handoff);
    } catch (cause) {
      transport.fail(cause, owner);
      throw cause;
    }
    transport.claim(this.owner);
    if (transport.maximumFrameBytes !== this.#handoff.maximumFrameBytes) {
      const failure = new HostSupervisorFactError(
        'invalid_handoff',
        'transport frame cap does not match the negotiated handoff',
      );
      transport.fail(failure, this.owner);
      throw failure;
    }
    this.#nowUnixMs = nowUnixMs;
    this.#lastInboundStreamSeq = this.#handoff.committedInboundStreamSeq;
    this.#ackAuthority = new HostSupervisorAckAuthority(
      this.#handoff,
      this.#nowUnixMs,
    );
    this.#history = new HostSupervisorReplayHistory(
      this.#handoff.trackedMessageIdCapacity,
      this.#handoff.maximumReplayBytes,
      [this.#handoff.bootstrapInboundMessageId],
    );
  }

  async beginReceive(): Promise<SupervisorFactReceiveOutcome> {
    this.#assertHealthy();
    if (this.#pending) {
      throw this.#poison(new HostSupervisorFactError(
        'pending_fact_active',
        'a supervisor fact is already awaiting a durable decision',
      ));
    }
    let encoded: Uint8Array | undefined;
    let opaquePayload: Uint8Array | undefined;
    let decodedPayload: agentV1Supervisor.ManagementPayload | undefined;
    let retainedPayload: agentV1Supervisor.ManagementPayload | undefined;
    try {
      encoded = await this.transport.receive(this.owner);
      if (!encoded) {
        throw new HostSupervisorFactError(
          'unexpected_eof',
          'management channel reached EOF before a fact',
        );
      }
      const validated = validateManagementFrame(encoded);
      opaquePayload = validated.frame.encodedPayload;
      decodedPayload = validated.payload;
      const header = validated.frame.header!;
      const observedAtUnixMs = this.#nowUnixMs();
      validateSupervisorEnvelopeHeader(
        header,
        observedAtUnixMs,
        this.#handoff,
      );
      const envelope = managementEnvelopeFingerprint(encoded);
      const envelopeDigest = envelope.hex;
      const replay = this.#history.classify(header.messageId, envelopeDigest);
      const disposition = validateSupervisorSequence(
        header.streamSeq,
        this.#lastInboundStreamSeq,
        replay,
        this.#history.canTrackFresh,
      );
      if (disposition.kind === 'replay') {
        await this.#replayAcknowledgement(
          disposition.encodedAcknowledgement,
        );
        return {
          kind: 'replayed',
          factCase: disposition.acknowledgement.factCase,
          messageId: header.messageId,
        };
      }
      retainedPayload = clone(
        agentV1Supervisor.ManagementPayloadSchema,
        validated.payload,
      );
      const fact = validateSupervisorFact(
        header,
        retainedPayload,
        observedAtUnixMs,
        this.#handoff,
      );
      const pending: PendingSupervisorFact = {
        fact,
        binding: Object.freeze({
          connectionId: header.connectionId,
          messageId: header.messageId,
          replyToMessageId: header.replyToMessageId,
          streamSeq: header.streamSeq,
          payloadSha256: header.payloadSha256.slice(),
          envelopeSha256: envelope.bytes.slice(),
          observedAtUnixMs,
        }),
        headerSentAtUnixMs: header.sentAtUnixMs,
        envelopeDigest,
        token: {},
      };
      const maximumAckBytes = this.#ackAuthority.maximumEncodedBytes(pending);
      assertSupervisorAckCapacity(
        maximumAckBytes,
        this.#handoff,
        this.#history,
      );
      this.#pending = pending;
      return { kind: 'pending', pending };
    } catch (cause) {
      throw this.#poison(normalizeSupervisorFactFailure(cause));
    } finally {
      encoded?.fill(0);
      opaquePayload?.fill(0);
      scrubManagementPayload(decodedPayload);
      scrubManagementPayload(retainedPayload);
    }
  }

  async acknowledge(pending: PendingSupervisorFact): Promise<void> {
    this.#assertHealthy();
    if (this.#pending !== pending || this.#pending.token !== pending.token) {
      throw this.#poison(new HostSupervisorFactError(
        'invalid_pending_fact',
        'pending fact authority is invalid',
      ));
    }
    let encoded: Uint8Array | undefined;
    try {
      const acknowledgement = this.#ackAuthority.prepare(pending);
      encoded = acknowledgement.encoded;
      const retainedEncoded = encoded;
      this.#history.commit(
        pending.binding.messageId,
        pending.envelopeDigest,
        acknowledgement.replay,
        retainedEncoded,
      );
      encoded = undefined;
      this.#lastInboundStreamSeq = pending.binding.streamSeq;
      this.#pending = undefined;
      await this.transport.send(retainedEncoded, this.owner);
      this.#ackAuthority.commit(acknowledgement);
    } catch (cause) {
      throw this.#poison(normalizeSupervisorFactFailure(cause));
    } finally {
      encoded?.fill(0);
    }
  }

  reject(pending: PendingSupervisorFact, cause: unknown): never {
    if (this.#pending !== pending) {
      throw this.#poison(new HostSupervisorFactError(
        'invalid_pending_fact',
        'cannot reject a foreign pending fact',
      ));
    }
    throw this.#poison(normalizeSupervisorFactFailure(
      cause,
      'durable_commit_failed',
    ));
  }

  abort(cause?: unknown): void {
    this.#poison(normalizeSupervisorFactFailure(cause, 'aborted'));
  }

  get isPoisoned(): boolean {
    return this.#failure !== undefined || this.transport.isFailed;
  }

  async #replayAcknowledgement(
    encodedAcknowledgement: Uint8Array,
  ): Promise<void> {
    await this.transport.send(encodedAcknowledgement, this.owner);
  }

  #assertHealthy(): void {
    if (this.#failure || this.transport.isFailed) {
      throw new HostSupervisorFactError(
        'channel_poisoned',
        'management fact channel is permanently poisoned',
        this.#failure ? { cause: this.#failure } : undefined,
      );
    }
  }

  #poison(cause: HostSupervisorFactError): HostSupervisorFactError {
    if (this.#failure) return this.#failure;
    this.#failure = cause;
    this.#pending = undefined;
    this.#history.clear();
    try {
      this.transport.fail(cause, this.owner);
    } catch {
      // Preserve the first protocol failure.
    }
    return cause;
  }
}
