import type {
  BoundedReplayOutcome,
  ReplayedFrame,
} from './AttemptFrameTransaction.js';
import { sharedReplayResponse } from './AttemptFrameTransaction.js';
import { AttemptFrameReceiverError } from './AttemptFrameReceiverError.js';

interface CommittedMessage {
  digest: string;
  streamSeq: bigint;
  envelopeDigest: Uint8Array;
  outcome: BoundedReplayOutcome;
}

export type HistoryMatch =
  | { kind: 'unknown' }
  | { kind: 'tombstone' }
  | { kind: 'conflict' }
  | { kind: 'replay'; replay: ReplayedFrame };

export class AttemptFrameHistory {
  readonly #active = new Map<string, CommittedMessage>();
  readonly #order: string[] = [];
  readonly #tombstones = new Set<string>();
  readonly #bufferReferences = new Map<Uint8Array, number>();
  #replayBytes = 0;

  constructor(
    private readonly replayCapacity: number,
    private readonly totalCapacity: number,
    bootstrapMessageId: string,
    private readonly maxReplayBytes: number,
  ) {
    this.#tombstones.add(bootstrapMessageId);
  }

  classify(
    messageId: string,
    digest: string,
  ): HistoryMatch {
    if (this.#tombstones.has(messageId)) return { kind: 'tombstone' };
    const committed = this.#active.get(messageId);
    if (!committed) return { kind: 'unknown' };
    if (committed.digest !== digest) return { kind: 'conflict' };
    return {
      kind: 'replay',
      replay: Object.freeze({
        messageId,
        streamSeq: committed.streamSeq,
        envelopeDigest: committed.envelopeDigest.slice(),
        outcome: committed.outcome,
      }),
    };
  }

  commit(messageId: string, committed: CommittedMessage): void {
    if (!this.canTrackNew) {
      throw new AttemptFrameReceiverError(
        'identity_capacity_exhausted',
        'total message identity capacity is exhausted',
      );
    }
    this.#evictForInsert();
    const response = sharedReplayResponse(committed.outcome);
    const additional = response && !this.#bufferReferences.has(response)
      ? response.byteLength
      : 0;
    if (this.#replayBytes + additional > this.maxReplayBytes) {
      throw new AttemptFrameReceiverError(
        'replay_byte_budget_exhausted',
        'replay byte budget is exhausted',
      );
    }
    this.#retain(response);
    this.#active.set(messageId, {
      ...committed,
      envelopeDigest: committed.envelopeDigest.slice(),
    });
    this.#order.push(messageId);
  }

  #evictForInsert(): void {
    while (this.#active.size >= this.replayCapacity) {
      const evicted = this.#order.shift();
      const committed = evicted === undefined
        ? undefined
        : this.#active.get(evicted);
      if (evicted !== undefined && committed && this.#active.delete(evicted)) {
        this.#release(sharedReplayResponse(committed.outcome));
        this.#tombstones.add(evicted);
      }
    }
  }

  #retain(response: Uint8Array | undefined): void {
    if (!response) return;
    const references = this.#bufferReferences.get(response) ?? 0;
    if (references === 0) this.#replayBytes += response.byteLength;
    this.#bufferReferences.set(response, references + 1);
  }

  #release(response: Uint8Array | undefined): void {
    if (!response) return;
    const references = this.#bufferReferences.get(response);
    if (references === undefined) return;
    if (references > 1) {
      this.#bufferReferences.set(response, references - 1);
      return;
    }
    this.#bufferReferences.delete(response);
    this.#replayBytes -= response.byteLength;
  }

  get canTrackNew(): boolean {
    return this.#active.size + this.#tombstones.size < this.totalCapacity;
  }

  get replayEntryCount(): number {
    return this.#active.size;
  }

  get tombstoneCount(): number {
    return this.#tombstones.size;
  }

  get replayBytes(): number {
    return this.#replayBytes;
  }

  clear(): void {
    this.#active.clear();
    this.#order.length = 0;
    this.#tombstones.clear();
    this.#bufferReferences.clear();
    this.#replayBytes = 0;
  }
}
