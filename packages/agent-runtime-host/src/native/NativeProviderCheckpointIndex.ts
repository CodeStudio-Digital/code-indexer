import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire, agentV1SessionStore as storeWire } from '@mcp/agent-runtime-contracts';
import {
  type EngineEventRecoveryStorePort, validateRecoveryPage, validateRecoveryPayload,
} from './NativeEngineEventRecovery.js';
import { MAX_FRONTIER_BYTES } from './ProviderFrontierCodec.js';
import { NATIVE_SESSION_MAX_RECORDS } from './NativeSessionStoreLimits.js';

/** Metadata comes from one authority-checked, immutable journal snapshot. The
 * native reader verifies the entire hash chain and payload integrity on open.
 * Reconstruct only the latest self-contained checkpoint and its deltas. This
 * index does not suppress the separate scan for unconfirmed physical effects. */
export async function latestProviderCheckpointBase(
  store: EngineEventRecoveryStorePort, sessionId: string, identityId: string, maximumRecords: number,
  identityField: 'agentRunId' | 'sourceAttemptId' = 'agentRunId',
): Promise<bigint> {
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords <= 0 || maximumRecords > NATIVE_SESSION_MAX_RECORDS) {
    throw new RangeError('engine event recovery scan limits');
  }
  const checkpoints: storeWire.CommitSessionRecordReceipt[] = [];
  let cursor = 0n; let count = 0;
  for (;;) {
    if (count >= maximumRecords) throw new Error('engine event recovery scan limit exceeded');
    const page = await store.list(cursor, Math.min(256, maximumRecords - count));
    validateRecoveryPage(page, sessionId, cursor, Math.min(256, maximumRecords - count));
    count += page.records.length;
    for (const receipt of page.records) {
      if (receipt.kind === storeWire.SessionRecordKind.CHECKPOINT) checkpoints.push(receipt);
    }
    if (page.complete) break;
    if (page.nextGlobalSequence <= cursor) throw new Error('engine event recovery cursor did not advance');
    cursor = page.nextGlobalSequence;
  }
  for (let index = checkpoints.length - 1; index >= 0; index--) {
    const receipt = checkpoints[index]!;
    const bytes = await store.read(receipt);
    validateRecoveryPayload(receipt, bytes);
    if (bytes.length > MAX_FRONTIER_BYTES) throw new Error('provider frontier byte limit');
    const record = fromBinary(wire.ProviderFrontierRecordV1Schema, bytes);
    if (record.frontier?.[identityField] !== identityId) continue;
    if (!Buffer.from(toBinary(wire.ProviderFrontierRecordV1Schema, record)).equals(bytes)
      || record.schemaVersion !== 1 || record.frontier.sessionId !== sessionId) {
      throw new Error('provider checkpoint index authority or encoding diverged');
    }
    if (!record.baseOperationId) return receipt.globalSequence;
  }
  // No complete base: retain the previous fail-closed behavior for a dangling
  // delta or a missing frontier instead of trusting an incomplete suffix.
  return 0n;
}
