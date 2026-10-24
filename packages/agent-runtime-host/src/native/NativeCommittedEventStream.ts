import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';

export interface NativeCommittedEvent {
  readonly record: wire.EngineEventRecordV1;
  readonly receipt: wire.CommitSessionRecordReceipt;
}

export class NativeEventReplayRequired extends Error {
  constructor(readonly afterSequence: bigint, readonly evictedThrough: bigint) {
    super('native event cursor expired; reload the durable journal snapshot');
  }
}

/** One bounded shared ring. A slow consumer keeps only its cursor, never a
 * private unbounded queue. Exact journal receipts permit durable reconnect. */
export class NativeCommittedEventStream {
  private readonly entries: { sequence: bigint; record: Uint8Array; receipt: Uint8Array }[] = [];
  private readonly waiters = new Set<() => void>();
  private bytes = 0;
  private evictedThrough = 0n;
  private latest = 0n;
  private closed = false;
  private subscribers = 0;

  constructor(private readonly maxRecords = 512, private readonly maxBytes = 8 * 1024 * 1024,
    initialSequence = 0n) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxBytes)
      || maxBytes < 256 * 1024 || initialSequence < 0n) throw new Error('invalid native event stream bounds');
    this.latest = initialSequence; this.evictedThrough = initialSequence;
  }

  get latestSequence() { return this.latest; }

  publish(record: wire.EngineEventRecordV1, receipt: wire.CommitSessionRecordReceipt): void {
    if (this.closed) throw new Error('native event stream is closed');
    if (receipt.globalSequence <= this.latest) {
      if (receipt.replay) return;
      throw new Error('native committed event sequence regressed');
    }
    const entry = { sequence: receipt.globalSequence,
      record: toBinary(wire.EngineEventRecordV1Schema, record),
      receipt: toBinary(wire.CommitSessionRecordReceiptSchema, receipt) };
    this.latest = entry.sequence;
    this.entries.push(entry);
    this.bytes += entry.record.byteLength + entry.receipt.byteLength;
    while (this.entries.length > this.maxRecords || this.bytes > this.maxBytes) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.record.byteLength + removed.receipt.byteLength;
      this.evictedThrough = removed.sequence;
    }
    this.wake();
  }

  subscribe(afterSequence = 0n, signal?: AbortSignal) {
    const controller = new AbortController();
    const iterator = this.drain(afterSequence, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    return {
      next: () => iterator.next(),
      return: async (_value?: unknown) => { controller.abort(); return iterator.return(undefined); },
      throw: async (cause?: unknown) => { controller.abort(); return iterator.throw(cause); },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  private async *drain(afterSequence: bigint, signal: AbortSignal): AsyncGenerator<NativeCommittedEvent> {
    if (afterSequence < 0n || afterSequence > this.latest) throw new Error('invalid native event cursor');
    if (this.subscribers >= 64) throw new Error('native event subscriber limit reached');
    this.subscribers++;
    let wake: (() => void) | undefined;
    try {
      while (!signal?.aborted) {
        if (afterSequence < this.evictedThrough) throw new NativeEventReplayRequired(afterSequence, this.evictedThrough);
        const next = this.entries.find((entry) => entry.sequence > afterSequence);
        if (next) {
          afterSequence = next.sequence;
          yield { record: fromBinary(wire.EngineEventRecordV1Schema, next.record),
            receipt: fromBinary(wire.CommitSessionRecordReceiptSchema, next.receipt) };
        } else {
          if (this.closed) return;
          await new Promise<void>((resolve) => {
            wake = () => resolve();
            this.waiters.add(wake);
            signal?.addEventListener('abort', wake, { once: true });
          });
          if (wake) { this.waiters.delete(wake); signal?.removeEventListener('abort', wake); wake = undefined; }
        }
      }
    } finally {
      this.subscribers--;
      if (wake) { this.waiters.delete(wake); signal?.removeEventListener('abort', wake); }
    }
  }

  close(): void { this.closed = true; this.wake(); }
  private wake(): void { for (const waiter of this.waiters) waiter(); this.waiters.clear(); }
}
