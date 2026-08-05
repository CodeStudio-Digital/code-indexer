import { createHash, timingSafeEqual } from 'node:crypto';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  agentV1Common,
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import { validateAttemptIdentity } from '../ipc/FrameHeaderValidation.js';
import type { UnresolvedCapabilityDispatch } from './NativeEngineEventRecoveryTypes.js';

export interface EngineEventRecoveryRecordPage {
  readonly records: readonly agentV1SessionStore.CommitSessionRecordReceipt[];
  readonly nextGlobalSequence: bigint;
  readonly complete: boolean;
}

export interface EngineEventRecoveryStorePort {
  list(
    afterGlobalSequence: bigint,
    maximumRecords: number,
  ): Promise<EngineEventRecoveryRecordPage>;
  read(receipt: agentV1SessionStore.CommitSessionRecordReceipt): Promise<Uint8Array>;
}

const PAGE_SIZE = 256;

/**
 * Scans a bounded, receipt-authenticated journal and returns started effects
 * for which no exact terminal proof exists. It never probes or retries them.
 */
export async function inspectUnresolvedCapabilityDispatches(
  store: EngineEventRecoveryStorePort,
  sessionId: string,
  maximumRecords: number,
): Promise<readonly UnresolvedCapabilityDispatch[]> {
  if (!validId(sessionId)
    || !Number.isSafeInteger(maximumRecords)
    || maximumRecords <= 0
    || maximumRecords > 65_536) {
    throw new RangeError('engine event recovery scan limits');
  }
  const unresolved = new Map<string, UnresolvedCapabilityDispatch>();
  let cursor = 0n;
  let scanned = 0;
  for (;;) {
    const remaining = maximumRecords - scanned;
    if (remaining <= 0) throw new Error('engine event recovery scan limit exceeded');
    const page = await store.list(cursor, Math.min(PAGE_SIZE, remaining));
    validatePage(page, sessionId, cursor);
    for (const receipt of page.records) {
      scanned += 1;
      cursor = receipt.globalSequence;
      if (receipt.kind !== agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT) continue;
      const encoded = await store.read(receipt);
      validatePayload(receipt, encoded);
      const record = fromBinary(
        agentV1SessionStore.EngineEventRecordV1Schema,
        encoded,
      );
      if (!Buffer.from(toBinary(
        agentV1SessionStore.EngineEventRecordV1Schema,
        record,
      )).equals(encoded)) {
        throw new Error('engine event recovery payload is not canonical');
      }
      applyRecord(record, receipt, sessionId, unresolved);
    }
    if (page.complete) break;
    if (page.nextGlobalSequence !== cursor || page.records.length === 0) {
      throw new Error('engine event recovery cursor did not advance');
    }
  }
  return Object.freeze([...unresolved.values()]);
}

function applyRecord(
  record: agentV1SessionStore.EngineEventRecordV1,
  receipt: agentV1SessionStore.CommitSessionRecordReceipt,
  sessionId: string,
  unresolved: Map<string, UnresolvedCapabilityDispatch>,
): void {
  const identity = record.identity;
  if (
    record.schemaVersion !== 1
    || !identity
    || identity.sessionId !== sessionId
    || !validId(record.runtimeInstanceId)
    || record.localSequence <= 0n
  ) throw new Error('engine event recovery authority is invalid');
  validateAttemptIdentity(identity);
  const keyPrefix = `${identity.attemptId}\0${record.runtimeInstanceId}\0`;
  if (record.body.case === 'capabilityDispatchStarted') {
    const value = record.body.value;
    if (!idsValid([value.operationId, value.toolUseId, value.grantId])
      || value.effectiveInputSha256.byteLength !== 32
      || value.startedAtUnixMs <= 0n) {
      throw new Error('engine capability started recovery record is invalid');
    }
    const key = `${keyPrefix}${value.operationId}`;
    if (unresolved.has(key)) {
      throw new Error('engine capability started recovery record is duplicated');
    }
    unresolved.set(key, Object.freeze({
      identity: Object.freeze(clone(agentV1Common.AttemptIdentitySchema, identity)),
      runtimeInstanceId: record.runtimeInstanceId,
      operationId: value.operationId,
      toolUseId: value.toolUseId,
      grantId: value.grantId,
      effectiveInputSha256: value.effectiveInputSha256.slice(),
      startedAtUnixMs: value.startedAtUnixMs,
      journalSequence: receipt.globalSequence,
      journalCommitSha256: receipt.commitSha256.slice(),
    }));
    return;
  }
  if (record.body.case !== 'capabilityTerminal') return;
  const value = record.body.value;
  const key = `${keyPrefix}${value.operationId}`;
  const started = unresolved.get(key);
  if (!started
    || started.toolUseId !== value.toolUseId
    || started.grantId !== value.grantId) {
    throw new Error('engine capability terminal lacks exact started authority');
  }
  unresolved.delete(key);
}

function validatePage(
  page: EngineEventRecoveryRecordPage,
  sessionId: string,
  after: bigint,
): void {
  if (page.records.length > PAGE_SIZE
    || page.nextGlobalSequence < after
    || (page.records.length === 0 && page.nextGlobalSequence !== after)) {
    throw new Error('engine event recovery page is invalid');
  }
  let expected = after;
  for (const receipt of page.records) {
    expected += 1n;
    if (receipt.sessionId !== sessionId
      || receipt.globalSequence !== expected
      || receipt.replay
      || receipt.payloadSha256.byteLength !== 32
      || receipt.commitSha256.byteLength !== 32) {
      throw new Error('engine event recovery receipt is invalid');
    }
  }
  if (page.nextGlobalSequence !== expected) {
    throw new Error('engine event recovery page sequence diverged');
  }
}

function validatePayload(
  receipt: agentV1SessionStore.CommitSessionRecordReceipt,
  payload: Uint8Array,
): void {
  if (BigInt(payload.byteLength) !== receipt.payloadBytes
    || !sameDigest(createHash('sha256').update(payload).digest(), receipt.payloadSha256)) {
    throw new Error('engine event recovery payload diverged from receipt');
  }
}

function idsValid(values: readonly string[]): boolean {
  return values.every(validId);
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !value.includes('\0');
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32
    && right.byteLength === 32
    && timingSafeEqual(left, right);
}
