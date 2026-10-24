import { createHash } from 'node:crypto';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { engineRecordStorage } from '../ipc/EngineContentRecord.js';
import { validateAttemptIdentity } from '../ipc/FrameHeaderValidation.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import type { NativeCommittedEvent } from './NativeCommittedEventStream.js';
import { NATIVE_SESSION_MAX_RECORDS } from './NativeSessionStoreLimits.js';

/** Incremental replay of one validated immutable journal snapshot. Payloads
 * are read one at a time through their exact native authority/receipt. */
export async function* replayNativeCommittedEvents(store: EngineEventRecoveryStorePort,
  sessionId: string, afterSequence = 0n, maximumRecords = 100_000,
  signal?: AbortSignal,
  onCheckpoint?: (receipt: wire.CommitSessionRecordReceipt, bytes: Uint8Array) => Promise<void>,
  onAttachment?: (receipt: wire.CommitSessionRecordReceipt, bytes: Uint8Array) => void,
  onReceipt?: (receipt: wire.CommitSessionRecordReceipt) => void): AsyncGenerator<NativeCommittedEvent> {
  if (afterSequence < 0n || !Number.isSafeInteger(maximumRecords)
    || maximumRecords < 1 || maximumRecords > NATIVE_SESSION_MAX_RECORDS) throw new RangeError('native replay bounds');
  let cursor = afterSequence;
  let scanned = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (scanned >= maximumRecords) throw new Error('native replay record bound exceeded');
    const count = Math.min(256, maximumRecords - scanned);
    const page = await store.list(cursor, count);
    if (page.records.length > count) throw new Error('native replay page exceeded bound');
    for (const receipt of page.records) {
      signal?.throwIfAborted();
      if (receipt.sessionId !== sessionId || receipt.globalSequence !== cursor + 1n) {
        throw new Error('native replay receipt sequence or session diverged');
      }
      cursor = receipt.globalSequence; scanned++;
      onReceipt?.(receipt);
      const checkpoint = receipt.kind === wire.SessionRecordKind.CHECKPOINT && onCheckpoint;
      const attachment = receipt.kind === wire.SessionRecordKind.ATTACHMENT && onAttachment;
      if (!checkpoint && !attachment && ![wire.SessionRecordKind.LIFECYCLE_EVENT, wire.SessionRecordKind.CONVERSATION,
        wire.SessionRecordKind.INPUT, wire.SessionRecordKind.TOOL_OUTPUT].includes(receipt.kind)) continue;
      if (receipt.payloadBytes <= 0n || receipt.payloadBytes > (checkpoint ? 16n * 1024n * 1024n : 256n * 1024n)) {
        throw new Error('native replay payload exceeded bound');
      }
      const bytes = await store.read(receipt);
      if (BigInt(bytes.byteLength) !== receipt.payloadBytes
        || createHash('sha256').update(bytes).digest('hex') !== Buffer.from(receipt.payloadSha256).toString('hex')) {
        throw new Error('native replay payload does not match durable receipt');
      }
      if (checkpoint) { await checkpoint(receipt, bytes); continue; }
      if (attachment) { attachment(receipt, bytes); continue; }
      const record = fromBinary(wire.EngineEventRecordV1Schema, bytes);
      const storage = engineRecordStorage(record);
      if (!record.identity || record.identity.sessionId !== sessionId || !record.runtimeInstanceId
        || record.localSequence <= 0n || record.schemaVersion !== 1 || record.body.case === undefined
        || storage.kind !== receipt.kind || storage.durability !== receipt.durability
        || !Buffer.from(toBinary(wire.EngineEventRecordV1Schema, record)).equals(bytes)) {
        throw new Error('native replay record authority or storage classification diverged');
      }
      validateAttemptIdentity(record.identity);
      yield { record, receipt };
    }
    if (page.nextGlobalSequence !== cursor || (!page.complete && page.records.length === 0)) {
      throw new Error('native replay cursor did not advance');
    }
    if (page.complete) return;
  }
}
