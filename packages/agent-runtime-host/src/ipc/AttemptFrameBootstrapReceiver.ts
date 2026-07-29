import { clone } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import {
  ATTEMPT_FRAME_MAX_BYTES,
  decodeAttemptPayload,
  validateOpaqueBootstrapAttemptFrame,
} from './AttemptFrame.js';
import { AttemptFrameBootstrapError } from './AttemptFrameBootstrapError.js';
import {
  type BootstrapReceiveOutcome,
  bootstrapConsumed,
  createBootstrapAgentHello,
  createBootstrapHostHello,
  validateHostSelection,
} from './AttemptFrameBootstrapModels.js';
import type { FrameDirection } from './AttemptFrameDirection.js';
import { MAX_INT64 } from './AttemptFrameReceiverTypes.js';
import { mintNegotiatedSeed } from './AttemptFrameSeed.js';
import {
  attemptIdentityEqual,
  validateAttemptIdentity,
} from './FrameHeaderValidation.js';

export class BootstrapReceiver {
  #consumed = false;
  readonly #expectedIdentity;

  constructor(
    expectedIdentity: agentV1Common.AttemptIdentity,
    private readonly direction: FrameDirection,
    private readonly hardMaximum: number,
    private readonly binding: object,
    private readonly expectedConnectionId?: string,
    private readonly expectedRuntimeInstanceId = '',
    private readonly expectedProtocolRange?: {
      readonly minimum: number;
      readonly maximum: number;
    },
  ) {
    try {
      validateAttemptIdentity(expectedIdentity);
    } catch (cause) {
      throw new AttemptFrameBootstrapError(
        'invalid_expected_identity',
        'bootstrap launch identity is invalid',
        { cause },
      );
    }
    if (
      !Number.isInteger(hardMaximum)
      || hardMaximum <= 0
      || hardMaximum > ATTEMPT_FRAME_MAX_BYTES[agentV1Runtime.TransportChannel.CONTROL]
    ) {
      throw new AttemptFrameBootstrapError('invalid_hard_cap', 'invalid bootstrap hard cap');
    }
    this.#expectedIdentity = clone(
      agentV1Common.AttemptIdentitySchema,
      expectedIdentity,
    );
  }

  receive(encoded: Uint8Array, clock: () => bigint): BootstrapReceiveOutcome {
    if (this.#consumed) throw bootstrapConsumed();
    this.#consumed = true;
    const observedAt = clock();
    if (observedAt <= 0n || observedAt > MAX_INT64) {
      throw new AttemptFrameBootstrapError(
        'invalid_observed_at',
        'bootstrap observed timestamp must be a positive int64',
      );
    }
    const opaque = validateOpaqueBootstrapAttemptFrame(encoded, this.hardMaximum);
    if (!attemptIdentityEqual(opaque.identity, this.#expectedIdentity)) {
      throw new AttemptFrameBootstrapError(
        'authority_mismatch',
        'bootstrap authority does not match launch',
      );
    }
    if (
      this.expectedConnectionId !== undefined
      && opaque.connectionId !== this.expectedConnectionId
    ) {
      throw new AttemptFrameBootstrapError(
        'connection_mismatch',
        'bootstrap connection does not match provisioned endpoint',
      );
    }
    if (
      this.expectedProtocolRange
      && (
        opaque.protocolVersion < this.expectedProtocolRange.minimum
        || opaque.protocolVersion > this.expectedProtocolRange.maximum
      )
    ) {
      throw new AttemptFrameBootstrapError(
        'protocol_mismatch',
        'bootstrap protocol is outside the launch range',
      );
    }
    const header = opaque.frame.header!;
    if (header.streamSeq !== 1n) {
      throw new AttemptFrameBootstrapError(
        'wrong_sequence',
        'bootstrap stream sequence must be 1',
      );
    }
    if (header.deadlineAtUnixMs !== undefined && observedAt >= header.deadlineAtUnixMs) {
      throw new AttemptFrameBootstrapError('deadline_expired', 'bootstrap deadline expired');
    }
    const validated = decodeAttemptPayload(opaque);
    if (this.direction === 'runner_to_host' && validated.payload.body.case === 'agentHello') {
      return {
        kind: 'agent_hello',
        hello: createBootstrapAgentHello(
          validated.payload.body.value,
          opaque.protocolVersion,
          opaque.envelopeDigest,
          opaque.identity,
          opaque.messageId,
          this.binding,
          this.hardMaximum,
        ),
      };
    }
    if (this.direction === 'host_to_runner' && validated.payload.body.case === 'hostHello') {
      const hello = validated.payload.body.value;
      const selected = validateHostSelection(hello, this.hardMaximum);
      if (selected.protocolVersion !== opaque.protocolVersion) {
        throw new AttemptFrameBootstrapError(
          'protocol_mismatch',
          'HostHello protocol does not match frame header',
        );
      }
      if (selected.connectionId !== opaque.connectionId) {
        throw new AttemptFrameBootstrapError(
          'connection_mismatch',
          'HostHello connection does not match frame header',
        );
      }
      const seed = mintNegotiatedSeed({
        ...selected,
        runtimeInstanceId: this.expectedRuntimeInstanceId,
        identity: opaque.identity,
        channel: agentV1Runtime.TransportChannel.CONTROL,
        direction: 'host_to_runner',
        streamWatermark: 1n,
        bootstrapMessageId: opaque.messageId,
        bootstrapBinding: this.binding,
      });
      return {
        kind: 'host_hello',
        hello: createBootstrapHostHello(hello, seed),
      };
    }
    throw new AttemptFrameBootstrapError(
      'wrong_payload',
      'payload is forbidden during bootstrap',
    );
  }
}
