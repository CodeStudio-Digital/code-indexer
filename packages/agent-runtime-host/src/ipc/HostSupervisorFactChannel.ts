import { clone } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { HostSupervisorFactError } from '../driver/HostSupervisorFactError.js';
import type {
  HostCancelAttemptRequest,
  HostFenceAttemptRequest,
  HostReapAttemptRequest,
} from '../driver/HostLifecycleTypes.js';
import type { HostSupervisorFactHandoff } from '../driver/HostSupervisorFactTypes.js';
import type { DelimitedByteChannel } from './DelimitedByteChannel.js';
import { validateManagementFrame } from './ManagementFrame.js';
import {
  HostSupervisorReplayHistory,
} from './HostSupervisorReplayHistory.js';
import {
  validateSupervisorEnvelopeHeader,
} from './HostSupervisorFactValidation.js';
import {
  managementEnvelopeFingerprint,
  normalizeSupervisorFactFailure,
} from './HostSupervisorAcknowledgement.js';
import type {
  PendingSupervisorFact,
  SupervisorFactReceiveOutcome,
} from './HostSupervisorFactChannelTypes.js';
import {
  assertSupervisorAckCapacity,
} from './HostSupervisorAckPreflight.js';
import {
  validateSupervisorSequence,
} from './HostSupervisorSequenceValidation.js';
import { scrubManagementPayload } from './ManagementPayloadScrub.js';
import { HostSupervisorCommandLane } from './HostSupervisorCommandLane.js';
import {
  preparePendingSupervisorFact,
} from './HostSupervisorPendingFact.js';
import {
  constructHostSupervisorFactChannel,
} from './HostSupervisorFactChannelConstruction.js';

export class HostSupervisorFactChannel {
  get remainingInboundIdentities(): number {
    this.#assertHealthy();
    return this.#history.remainingIdentityCapacity - (this.#pending ? 1 : 0);
  }

  readonly #history: HostSupervisorReplayHistory;
  readonly #handoff;
  readonly #nowUnixMs;
  readonly #commands: HostSupervisorCommandLane;
  #lastInboundStreamSeq: bigint;
  #pending?: PendingSupervisorFact;
  #failure?: HostSupervisorFactError;

  constructor(
    private readonly transport: DelimitedByteChannel,
    private readonly owner: object,
    handoff: HostSupervisorFactHandoff,
    nowUnixMs: () => bigint,
  ) {
    this.#nowUnixMs = nowUnixMs;
    const constructed = constructHostSupervisorFactChannel(
      transport,
      owner,
      handoff,
      nowUnixMs,
      (cause) => { this.#poison(cause); },
    );
    this.#handoff = constructed.handoff;
    this.#lastInboundStreamSeq = this.#handoff.committedInboundStreamSeq;
    this.#commands = constructed.commands;
    this.#history = constructed.history;
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
      encoded = await this.transport.receiveAfterIdle(this.owner);
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
        await this.#commands.replay(disposition.encodedAcknowledgement);
        return {
          kind: 'replayed',
          factCase: disposition.acknowledgement.factCase,
          messageId: header.messageId,
        };
      }
      if (decodedPayload.body.case === 'managementAck') {
        const commandCase = await this.#commands.acceptAcknowledgement(
          header,
          decodedPayload.body.value,
          observedAtUnixMs,
        );
        this.#history.retireFresh(header.messageId);
        this.#lastInboundStreamSeq = header.streamSeq;
        return {
          kind: 'command_acknowledged',
          commandCase,
          messageId: header.messageId,
        };
      }
      retainedPayload = clone(
        agentV1Supervisor.ManagementPayloadSchema,
        validated.payload,
      );
      const pending = preparePendingSupervisorFact(
        header,
        retainedPayload,
        observedAtUnixMs,
        this.#handoff,
        envelope.bytes,
        envelopeDigest,
      );
      const maximumAckBytes = this.#commands.maximumAcknowledgementBytes(pending);
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
    try {
      await this.#commands.acknowledge(pending, (acknowledgement) => {
        this.#history.commit(
          pending.binding.messageId,
          pending.envelopeDigest,
          acknowledgement.replay,
          acknowledgement.encoded,
        );
        this.#lastInboundStreamSeq = pending.binding.streamSeq;
        this.#pending = undefined;
      });
    } catch (cause) {
      throw this.#poison(normalizeSupervisorFactFailure(cause));
    }
  }

  renewAuthority(request: import('../driver/HostLifecycleTypes.js').HostAuthorityRenewalRequest, timeoutMs: number): Promise<void> {
    this.#assertHealthy(); return this.#commands.renewAuthority(request, timeoutMs);
  }

  cancel(request: HostCancelAttemptRequest, timeoutMs: number): Promise<void> {
    this.#assertHealthy(); return this.#commands.cancel(request, timeoutMs);
  }

  fence(request: HostFenceAttemptRequest, timeoutMs: number): Promise<void> {
    this.#assertHealthy(); return this.#commands.fence(request, timeoutMs);
  }

  reap(request: HostReapAttemptRequest, timeoutMs: number): Promise<void> {
    this.#assertHealthy(); return this.#commands.reap(request, timeoutMs);
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

  get isPoisoned(): boolean { return !!this.#failure || this.transport.isFailed; }

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
    this.#commands.abort(cause);
    this.#history.clear();
    try {
      this.transport.fail(cause, this.owner);
    } catch {
      // Preserve the first protocol failure.
    }
    return cause;
  }
}
