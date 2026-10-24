import type {
  SupervisorLifecycleFactCase,
} from '../driver/HostSupervisorFactTypes.js';

export interface SupervisorAckReplay {
  readonly inboundMessageId: string;
  readonly inboundPayloadSha256: Uint8Array;
  readonly outboundMessageId: string;
  readonly inboundStreamSeq: bigint;
  readonly outboundStreamSeq: bigint;
  readonly acknowledgedAtUnixMs: bigint;
  readonly factCase: SupervisorLifecycleFactCase;
}

interface ReplayEntry {
  readonly messageId: string;
  readonly envelopeDigest: string;
  readonly acknowledgement: SupervisorAckReplay;
  readonly encodedAcknowledgement: Uint8Array;
}

export type ReplayClassification =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'retired' }
  | { readonly kind: 'conflict' }
  | {
    readonly kind: 'replay';
    readonly acknowledgement: SupervisorAckReplay;
    readonly encodedAcknowledgement: Uint8Array;
  };

/**
 * V1 retains exactly one replayable ACK. Older identities become bounded
 * tombstones so an old message ID can never silently become fresh again.
 */
export class HostSupervisorReplayHistory {
  #active?: ReplayEntry;
  readonly #retired = new Set<string>();

  constructor(
    private readonly identityCapacity: number,
    private readonly byteCapacity: number,
    retiredMessageIds: readonly string[] = [],
  ) {
    for (const messageId of retiredMessageIds) this.#retired.add(messageId);
  }

  classify(
    messageId: string,
    envelopeDigest: string,
  ): ReplayClassification {
    if (this.#retired.has(messageId)) return { kind: 'retired' };
    if (this.#active?.messageId !== messageId) return { kind: 'fresh' };
    if (this.#active.envelopeDigest !== envelopeDigest) {
      return { kind: 'conflict' };
    }
    return {
      kind: 'replay',
      acknowledgement: this.#active.acknowledgement,
      encodedAcknowledgement: this.#active.encodedAcknowledgement,
    };
  }

  get canTrackFresh(): boolean {
    return this.#retired.size + (this.#active ? 1 : 0)
      < this.identityCapacity;
  }

  get remainingIdentityCapacity(): number {
    return this.identityCapacity - this.#retired.size - (this.#active ? 1 : 0);
  }

  canRetain(byteLength: number): boolean {
    return byteLength > 0 && byteLength <= this.byteCapacity;
  }

  retireFresh(messageId: string): void {
    if (!this.canTrackFresh || this.classify(messageId, '').kind !== 'fresh') {
      throw new RangeError('management message identity cannot be retired');
    }
    this.#retired.add(messageId);
  }

  commit(
    messageId: string,
    envelopeDigest: string,
    acknowledgement: SupervisorAckReplay,
    encodedAcknowledgement: Uint8Array,
  ): void {
    if (!this.canTrackFresh) {
      throw new RangeError('management message identity capacity exhausted');
    }
    if (!this.canRetain(encodedAcknowledgement.byteLength)) {
      throw new RangeError('management replay byte capacity exhausted');
    }
    if (this.#active) {
      this.#retired.add(this.#active.messageId);
      this.#active.encodedAcknowledgement.fill(0);
    }
    this.#active = {
      messageId,
      envelopeDigest,
      acknowledgement,
      encodedAcknowledgement,
    };
  }

  clear(): void {
    this.#active?.encodedAcknowledgement.fill(0);
    this.#active = undefined;
    this.#retired.clear();
  }
}
