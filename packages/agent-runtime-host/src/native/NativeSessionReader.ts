import { randomUUID } from 'node:crypto';
import { clone, create } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { VerifiedRuntimePackage } from '../packaging/RuntimePackageTypes.js';
import { loadNativeHostBridge } from './NativeHostBridgeLoader.js';
import { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';
import { nativeSessionRecoveryStore } from './NativeSessionRecoveryStore.js';
import type { EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import { NATIVE_SESSION_FRAME_BYTES, NATIVE_SESSION_PAYLOAD_BYTES, NATIVE_SESSION_MAX_RECORDS } from './NativeSessionStoreLimits.js';

/** Read capability over one validated immutable snapshot. No writer is opened. */
export class NativeSessionReader {
  readonly store: EngineEventRecoveryStorePort;
  private closed = false;
  private constructor(private readonly client: NativeSessionStoreBridgeClient,
    private readonly handle: string, readonly state: wire.SessionState,
    readonly snapshotId: string, private readonly authority: wire.SessionStoreAuthority) {
    this.store = nativeSessionRecoveryStore(client, '', state.sessionId, authority, handle);
  }

  static async open(runtimePackage: VerifiedRuntimePackage, options: {
    rootPath: string; sessionId: string; authority?: wire.SessionStoreAuthority;
  }): Promise<NativeSessionReader> {
    const instance = `session-reader:${randomUUID()}`;
    const rootId = 'native-product-sessions';
    const owner = loadNativeHostBridge(runtimePackage).openNativeSessionStoreBridge(
      instance, rootId, options.rootPath, NATIVE_SESSION_FRAME_BYTES);
    const client = new NativeSessionStoreBridgeClient(owner, instance, () => BigInt(Date.now()), 30_000n);
    const authority = options.authority && clone(wire.SessionStoreAuthoritySchema, options.authority);
    try {
      const opened = await client.request({ case: 'openSessionReader', value: create(wire.OpenSessionReaderSchema, {
        rootId, sessionId: options.sessionId, authority,
        limits: { maxRecords: BigInt(NATIVE_SESSION_MAX_RECORDS), maxPayloadBytes: BigInt(NATIVE_SESSION_PAYLOAD_BYTES), maxAuthorityTransitions: 100_000n },
      }) });
      if (opened.case !== 'sessionReaderOpened' || !opened.value.readerHandle || !opened.value.snapshotId
        || opened.value.state?.sessionId !== options.sessionId
        || !opened.value.state.authority?.writerId || opened.value.state.authority.leaseEpoch <= 0n
        || opened.value.state.authority.storageGeneration !== wire.StorageGeneration.RUST_FS_V1
        || (authority && (opened.value.state.authority.writerId !== authority.writerId
          || opened.value.state.authority.leaseEpoch !== authority.leaseEpoch
          || opened.value.state.authority.storageGeneration !== authority.storageGeneration))) {
        throw new Error('native session reader authority diverged');
      }
      return new NativeSessionReader(client, opened.value.readerHandle, opened.value.state, opened.value.snapshotId,
        clone(wire.SessionStoreAuthoritySchema, opened.value.state.authority));
    } catch (error) { await client.close(); throw error; }
  }

  async assertCurrent(): Promise<void> {
    await this.client.request({ case: 'querySessionState', value: create(wire.QuerySessionStateSchema, {
      readerHandle: this.handle, authority: this.authority,
    }) });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.request({ case: 'closeSessionReader', value: create(wire.CloseSessionReaderSchema, {
        readerHandle: this.handle, authority: this.authority,
      }) });
    } finally { await this.client.close(); }
  }
}
