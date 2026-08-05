import { createHash, timingSafeEqual } from 'node:crypto';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1SessionStore,
} from '@mcp/agent-runtime-contracts';
import type {
  DurableEngineEventCommitPort,
  DurableEngineEventCommitRequest,
} from '../ipc/DurableEngineEventCommitPort.js';
import {
  assertNativeSessionStoreBridge,
  type NativeHostBridgeBinding,
} from './NativeHostBridgeBinding.js';
import { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';
import {
  inspectUnresolvedCapabilityDispatches,
} from './NativeEngineEventRecovery.js';
import type {
  UnresolvedCapabilityDispatch,
} from './NativeEngineEventRecoveryTypes.js';

const OPERATION_DOMAIN = Buffer.from('codestudio.agent.engine-event-operation.v1\0');

export interface NativeDurableEngineEventCommitterOptions {
  readonly instanceId: string;
  readonly rootId: string;
  /** Application session root. Individual bundle paths never cross the ABI. */
  readonly rootPath: string;
  readonly maximumFrameBytes: number;
  readonly sessionId: string;
  readonly authority: agentV1SessionStore.SessionStoreAuthority;
  readonly limits: agentV1SessionStore.SessionStoreLimits;
  readonly openIdempotencyKey: string;
  readonly nowUnixMs: () => bigint;
  readonly timeoutMs: bigint;
}

export class NativeDurableEngineEventCommitter
implements DurableEngineEventCommitPort {
  private constructor(
    private readonly client: NativeSessionStoreBridgeClient,
    private readonly writerHandle: string,
    private readonly sessionId: string,
    private readonly authority: agentV1SessionStore.SessionStoreAuthority,
  ) {}

  static async open(
    binding: NativeHostBridgeBinding,
    options: NativeDurableEngineEventCommitterOptions,
  ): Promise<NativeDurableEngineEventCommitter> {
    const owner = binding.openNativeSessionStoreBridge(
      options.instanceId,
      options.rootId,
      options.rootPath,
      options.maximumFrameBytes,
    );
    assertNativeSessionStoreBridge(owner);
    const client = new NativeSessionStoreBridgeClient(
      owner,
      options.instanceId,
      options.nowUnixMs,
      options.timeoutMs,
    );
    try {
      const body = await client.request({
        case: 'openSessionWriter',
        value: create(agentV1SessionStore.OpenSessionWriterSchema, {
          rootId: options.rootId,
          sessionId: options.sessionId,
          authority: options.authority,
          limits: options.limits,
          idempotencyKey: options.openIdempotencyKey,
        }),
      });
      if (
        body.case !== 'sessionWriterOpened'
        || body.value.sessionId !== options.sessionId
        || body.value.writerHandle.length === 0
        || !sameAuthority(body.value.authority, options.authority)
      ) throw new Error('native session writer opening diverged');
      return new NativeDurableEngineEventCommitter(
        client,
        body.value.writerHandle,
        options.sessionId,
        clone(agentV1SessionStore.SessionStoreAuthoritySchema, options.authority),
      );
    } catch (cause) {
      await client.close().catch(() => undefined);
      throw cause;
    }
  }

  async commit(request: DurableEngineEventCommitRequest) {
    const payload = toBinary(
      agentV1SessionStore.EngineEventRecordV1Schema,
      request.record,
    );
    const payloadSha256 = createHash('sha256').update(payload).digest();
    if (
      request.identity.sessionId !== this.sessionId
      || !sameDigest(payloadSha256, request.expectedPayloadSha256)
    ) throw new Error('native engine event crosses writer authority');
    const body = await this.client.request({
      case: 'commitSessionRecord',
      value: create(agentV1SessionStore.CommitSessionRecordSchema, {
        writerHandle: this.writerHandle,
        authority: this.authority,
        operationId: eventOperationId(
          request.identity.attemptId,
          request.record.localSequence,
        ),
        kind: agentV1SessionStore.SessionRecordKind.LIFECYCLE_EVENT,
        durability: durability(request.record),
        encodedPayload: payload,
        expectedPayloadSha256: payloadSha256,
      }),
    });
    if (body.case !== 'commitSessionRecordReceipt') {
      throw new Error('native session commit receipt is missing');
    }
    return body.value;
  }

  async inspectUnresolvedCapabilityDispatches(
    maximumRecords: number,
  ): Promise<readonly UnresolvedCapabilityDispatch[]> {
    return inspectUnresolvedCapabilityDispatches({
      list: async (afterGlobalSequence, maximumPageRecords) => {
        const body = await this.client.request({
          case: 'listCommittedSessionRecords',
          value: create(agentV1SessionStore.ListCommittedSessionRecordsSchema, {
            writerHandle: this.writerHandle,
            authority: this.authority,
            afterGlobalSequence,
            maxRecords: maximumPageRecords,
          }),
        });
        if (body.case !== 'committedSessionRecordPage'
          || body.value.sessionId !== this.sessionId) {
          throw new Error('native session record page is missing or foreign');
        }
        return body.value;
      },
      read: async (receipt) => {
        const body = await this.client.request({
          case: 'readCommittedSessionPayload',
          value: create(agentV1SessionStore.ReadCommittedSessionPayloadSchema, {
            writerHandle: this.writerHandle,
            authority: this.authority,
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
    }, this.sessionId, maximumRecords);
  }

  async close(): Promise<void> {
    try {
      await this.client.request({
        case: 'closeSessionWriter',
        value: create(agentV1SessionStore.CloseSessionWriterSchema, {
          writerHandle: this.writerHandle,
          authority: this.authority,
        }),
      });
    } finally {
      await this.client.close();
    }
  }
}

function eventOperationId(attemptId: string, sequence: bigint): string {
  const sequenceBytes = Buffer.alloc(8);
  sequenceBytes.writeBigUInt64BE(sequence);
  const digest = createHash('sha256')
    .update(OPERATION_DOMAIN)
    .update(attemptId)
    .update(sequenceBytes)
    .digest();
  const value = Buffer.from(digest.subarray(0, 16));
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function durability(record: agentV1SessionStore.EngineEventRecordV1) {
  if (record.body.case === 'providerDelta') {
    return agentV1SessionStore.SessionDurabilityClass.COALESCED;
  }
  return record.body.case === 'capabilityBoundary'
    || record.body.case === 'capabilityDispatchStarted'
    || record.body.case === 'capabilityTerminal'
    || record.body.case === 'terminal'
    ? agentV1SessionStore.SessionDurabilityClass.AUTHORITATIVE
    : agentV1SessionStore.SessionDurabilityClass.DURABLE;
}

function sameAuthority(
  actual: agentV1SessionStore.SessionStoreAuthority | undefined,
  expected: agentV1SessionStore.SessionStoreAuthority,
): boolean {
  return actual?.storageGeneration === expected.storageGeneration
    && actual.leaseEpoch === expected.leaseEpoch
    && actual.writerId === expected.writerId;
}

function sameDigest(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.byteLength === 32
    && expected.byteLength === 32
    && timingSafeEqual(actual, expected);
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
