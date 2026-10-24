import { create } from '@bufbuild/protobuf';
import { agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import type { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';

export function nativeSessionRecoveryStore(client: NativeSessionStoreBridgeClient, writerHandle: string,
  sessionId: string, authority: agentV1SessionStore.SessionStoreAuthority, readerHandle = ''): EngineEventRecoveryStorePort {
  let snapshotId = '';
  return {
    list: async (afterGlobalSequence, maximumPageRecords) => {
      const body = await client.request({
        case: 'listCommittedSessionRecords',
        value: create(agentV1SessionStore.ListCommittedSessionRecordsSchema, {
          writerHandle,
          readerHandle,
          authority,
          afterGlobalSequence,
          maxRecords: maximumPageRecords,
          snapshotId,
        }),
      });
      if (body.case !== 'committedSessionRecordPage'
        || body.value.sessionId !== sessionId) {
        throw new Error('native session record page is missing or foreign');
      }
      if (!body.value.snapshotId || (snapshotId && snapshotId !== body.value.snapshotId)) {
        throw new Error('native session recovery snapshot is missing or changed');
      }
      snapshotId = body.value.snapshotId;
      return body.value;
    },
    read: async (receipt) => {
      const body = await client.request({
        case: 'readCommittedSessionPayload',
        value: create(agentV1SessionStore.ReadCommittedSessionPayloadSchema, {
          writerHandle,
          readerHandle,
          authority,
          operationId: receipt.operationId,
          kind: receipt.kind,
          expectedPayloadSha256: receipt.payloadSha256,
          expectedPayloadBytes: receipt.payloadBytes,
        }),
      });
      if (body.case !== 'committedSessionPayload'
        || !body.value.commitReceipt
        || !sameReceipt(body.value.commitReceipt, receipt)) {
        throw new Error('native committed session payload receipt diverged');
      }
      return body.value.encodedPayload;
    },
  };
}

function sameReceipt(
  actual: agentV1SessionStore.CommitSessionRecordReceipt,
  expected: agentV1SessionStore.CommitSessionRecordReceipt,
): boolean {
  return actual.sessionId === expected.sessionId
    && actual.operationId === expected.operationId
    && actual.globalSequence === expected.globalSequence
    && actual.kind === expected.kind
    && actual.durability === expected.durability
    && actual.payloadBytes === expected.payloadBytes
    && sameDigest(actual.payloadSha256, expected.payloadSha256)
    && sameDigest(actual.commitSha256, expected.commitSha256);
}

function sameDigest(a: Uint8Array, b: Uint8Array): boolean { return a.length === 32 && b.length === 32 && Buffer.from(a).equals(b); }
