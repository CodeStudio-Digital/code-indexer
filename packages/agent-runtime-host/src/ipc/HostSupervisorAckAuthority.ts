import { randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import {
  HostSupervisorFactError,
} from '../driver/HostSupervisorFactError.js';
import type {
  HostSupervisorFactHandoff,
} from '../driver/HostSupervisorFactTypes.js';
import type {
  PendingSupervisorFact,
} from './HostSupervisorFactChannelTypes.js';
import {
  latestLocalPeerTimestamp,
} from './LocalPeerClock.js';
import {
  encodeSupervisorAcknowledgement,
} from './HostSupervisorAcknowledgement.js';
import {
  encodeManagementFrame,
  managementPayloadSha256,
} from './ManagementFrame.js';
import type {
  PreparedSupervisorCommand,
  SupervisorCommandBody,
} from './HostSupervisorCommandTypes.js';
import type {
  SupervisorAckReplay,
} from './HostSupervisorReplayHistory.js';

const MAX_INT64 = (1n << 63n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

export interface PreparedSupervisorAcknowledgement {
  readonly replay: SupervisorAckReplay;
  readonly encoded: Uint8Array;
}

export class HostSupervisorAckAuthority {
  readonly #senderNonce = randomUUID();
  #lastStreamSeq: bigint;

  constructor(
    private readonly handoff: HostSupervisorFactHandoff,
    private readonly nowUnixMs: () => bigint,
  ) {
    this.#lastStreamSeq = handoff.committedOutboundStreamSeq;
  }

  prepare(
    pending: PendingSupervisorFact,
  ): PreparedSupervisorAcknowledgement {
    const ownerNowUnixMs = this.nowUnixMs();
    if (
      ownerNowUnixMs <= 0n
      || ownerNowUnixMs > MAX_INT64
      || pending.headerSentAtUnixMs
        > latestLocalPeerTimestamp(ownerNowUnixMs)
      || this.#lastStreamSeq === MAX_UINT64
    ) {
      throw new HostSupervisorFactError(
        'invalid_header',
        'ACK clock or outbound sequence is invalid',
      );
    }
    const acknowledgedAtUnixMs = pending.headerSentAtUnixMs > ownerNowUnixMs
      ? pending.headerSentAtUnixMs
      : ownerNowUnixMs;
    const replay = this.#replay(pending, acknowledgedAtUnixMs);
    return {
      replay,
      encoded: encodeSupervisorAcknowledgement(this.handoff, replay),
    };
  }

  maximumEncodedBytes(pending: PendingSupervisorFact): number {
    const replay = this.#replay(pending, MAX_INT64);
    const encoded = encodeSupervisorAcknowledgement(this.handoff, replay);
    const length = encoded.byteLength;
    encoded.fill(0);
    return length;
  }

  commit(prepared: PreparedSupervisorAcknowledgement): void {
    if (prepared.replay.outboundStreamSeq !== this.#lastStreamSeq + 1n) {
      throw new HostSupervisorFactError(
        'invalid_pending_fact',
        'ACK reservation no longer owns the next outbound sequence',
      );
    }
    this.#lastStreamSeq = prepared.replay.outboundStreamSeq;
  }

  prepareCommand(
    body: SupervisorCommandBody,
    deadlineAtUnixMs: bigint,
  ): PreparedSupervisorCommand {
    const sentAtUnixMs = this.nowUnixMs();
    if (
      sentAtUnixMs <= 0n
      || sentAtUnixMs > MAX_INT64
      || deadlineAtUnixMs <= sentAtUnixMs
      || deadlineAtUnixMs > MAX_INT64
      || this.#lastStreamSeq === MAX_UINT64
    ) throw new HostSupervisorFactError('invalid_header', 'command clock is invalid');
    const streamSeq = this.#lastStreamSeq + 1n;
    const messageId = `management-command:${this.#senderNonce}:${streamSeq}`;
    const payload = create(agentV1Supervisor.ManagementPayloadSchema, { body });
    const encodedPayload = toBinary(agentV1Supervisor.ManagementPayloadSchema, payload);
    const payloadSha256 = managementPayloadSha256(encodedPayload);
    encodedPayload.fill(0);
    return {
      case: body.case,
      messageId,
      streamSeq,
      sentAtUnixMs,
      deadlineAtUnixMs,
      payloadSha256,
      encoded: encodeManagementFrame(create(
        agentV1Supervisor.ManagementFrameHeaderSchema,
        {
          protocolVersion: this.handoff.protocolVersion,
          connectionId: this.handoff.connectionId,
          messageId,
          streamSeq,
          sentAtUnixMs,
          deadlineAtUnixMs,
        },
      ), payload),
    };
  }

  commitCommand(prepared: PreparedSupervisorCommand): void {
    if (prepared.streamSeq !== this.#lastStreamSeq + 1n) {
      throw new HostSupervisorFactError(
        'invalid_command',
        'command no longer owns the next outbound sequence',
      );
    }
    this.#lastStreamSeq = prepared.streamSeq;
  }

  #replay(
    pending: PendingSupervisorFact,
    acknowledgedAtUnixMs: bigint,
  ): SupervisorAckReplay {
    const outboundStreamSeq = this.#lastStreamSeq + 1n;
    return {
      inboundMessageId: pending.binding.messageId,
      inboundPayloadSha256: pending.binding.payloadSha256.slice(),
      outboundMessageId: `management-ack:${this.#senderNonce}:${outboundStreamSeq}`,
      inboundStreamSeq: pending.binding.streamSeq,
      outboundStreamSeq,
      acknowledgedAtUnixMs,
      factCase: pending.fact.case,
    };
  }
}
