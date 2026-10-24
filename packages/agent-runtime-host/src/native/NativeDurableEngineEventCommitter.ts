import { nativeSessionRecoveryStore } from './NativeSessionRecoveryStore.js';
import { commitNativeSessionAttachment } from './NativeSessionAttachments.js';
import type { ProviderArtifactReaderPort } from '../provider-gateway/ProviderGatewayTypes.js';
import type { agentV1Artifact } from '@mcp/agent-runtime-contracts';
import { engineRecordStorage } from '../ipc/EngineContentRecord.js';
import { NativeCommittedEventStream } from './NativeCommittedEventStream.js';
import { NativeContentAssembler } from './NativeContentAssembler.js';
import { replayNativeCommittedEvents } from './NativeCommittedEventReplay.js';
import { NativeEngineCompletion } from './NativeEngineCompletion.js';
import { NativeProviderFrontierWriter } from './NativeProviderFrontierWriter.js';
import { NativeWriterHistoryReads } from './NativeWriterHistoryReads.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import { inspectProviderFrontier } from './NativeProviderFrontierRecovery.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import {
  agentV1SessionStore,
  type agentV1Runtime,
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
  private readonly frontiers: NativeProviderFrontierWriter;
  private readonly completion = new NativeEngineCompletion();
  private readonly events: NativeCommittedEventStream;
  private readonly content = new NativeContentAssembler();
  private validatedSequence = 0n;
  private readonly historyReads = new NativeWriterHistoryReads();

  readCommittedHistory<T>(project: (store: EngineEventRecoveryStorePort) => Promise<T>): Promise<T | undefined> {
    return this.historyReads.read(() => nativeSessionRecoveryStore(this.client, this.writerHandle,
      this.sessionId, this.authority), project);
  }

  waitForTerminal() { return this.completion.settled; }
  get latestSequence() { return this.events.latestSequence; }
  subscribeCommittedEvents(afterSequence = 0n, signal?: AbortSignal) {
    return this.events.subscribe(afterSequence, signal);
  }
  replayCommittedEvents(afterSequence = 0n, maximumRecords = 100_000, signal?: AbortSignal) {
    return replayNativeCommittedEvents(
      nativeSessionRecoveryStore(this.client, this.writerHandle, this.sessionId, this.authority),
      this.sessionId, afterSequence, maximumRecords, signal);
  }
  afterEngineEventAcknowledged(record: agentV1SessionStore.EngineEventRecordV1,
    receipt: agentV1SessionStore.CommitSessionRecordReceipt): void {
    if (receipt.replay && receipt.globalSequence <= this.events.latestSequence) return;
    this.events.publish(record, receipt);
    this.completion.acknowledge(record);
    if (record.body.case === 'terminal') this.events.close();
  }

  private constructor(
    private readonly client: NativeSessionStoreBridgeClient,
    private readonly writerHandle: string,
    private readonly sessionId: string,
    private readonly authority: agentV1SessionStore.SessionStoreAuthority,
    committedRecords: bigint,
  ) {
    this.frontiers = new NativeProviderFrontierWriter(client, writerHandle, sessionId, authority);
    this.events = new NativeCommittedEventStream(512, 8 * 1024 * 1024, committedRecords);
  }

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
        body.value.committedRecords,
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
        ...engineRecordStorage(request.record),
        encodedPayload: payload,
        expectedPayloadSha256: payloadSha256,
      }),
    });
    if (body.case !== 'commitSessionRecordReceipt') {
      throw new Error('native session commit receipt is missing');
    }
    if (body.value.globalSequence > this.validatedSequence) {
      if (request.record.body.case === 'content') this.content.append(request.record.body.value);
      else this.content.assertComplete();
      this.validatedSequence = body.value.globalSequence;
    }
    return body.value;
  }

  async inspectUnresolvedCapabilityDispatches(
    maximumRecords: number,
  ): Promise<readonly UnresolvedCapabilityDispatch[]> {
    return inspectUnresolvedCapabilityDispatches(
      nativeSessionRecoveryStore(this.client, this.writerHandle, this.sessionId, this.authority),
      this.sessionId, maximumRecords,
    );
  }

  inspectProviderFrontier(agentRunId: string, maximumRecords: number) {
    return inspectProviderFrontier(
      nativeSessionRecoveryStore(this.client, this.writerHandle, this.sessionId, this.authority),
      this.sessionId, agentRunId, maximumRecords,
    );
  }

  commitProviderFrontier(start: agentV1Runtime.ProviderStart, signal: AbortSignal): Promise<void> {
    return this.frontiers.commit(start, signal);
  }

  commitAttachment(reference: agentV1Artifact.ArtifactRef, reader: ProviderArtifactReaderPort, signal: AbortSignal): Promise<void> {
    return commitNativeSessionAttachment(this.client, this.writerHandle, this.authority, this.sessionId, reference, reader, signal);
  }

  async close(): Promise<void> {
    await this.historyReads.close();
    this.events.close();
    this.completion.close();
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
