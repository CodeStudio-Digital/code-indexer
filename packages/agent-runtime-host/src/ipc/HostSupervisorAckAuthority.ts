import { randomUUID } from 'node:crypto';
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
  encodeSupervisorAcknowledgement,
} from './HostSupervisorAcknowledgement.js';
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
    const acknowledgedAtUnixMs = this.nowUnixMs();
    if (
      acknowledgedAtUnixMs < pending.headerSentAtUnixMs
      || acknowledgedAtUnixMs <= 0n
      || acknowledgedAtUnixMs > MAX_INT64
      || this.#lastStreamSeq === MAX_UINT64
    ) {
      throw new HostSupervisorFactError(
        'invalid_header',
        'ACK clock or outbound sequence is invalid',
      );
    }
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
