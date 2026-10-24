import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { create } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { VerifiedRuntimePackage } from '../packaging/RuntimePackageTypes.js';
import { loadNativeHostBridge } from './NativeHostBridgeLoader.js';
import { NativeSessionStoreBridgeClient, NativeSessionStoreRequestError } from './NativeSessionStoreBridgeClient.js';

/** Each transaction owns an OS lock, released by close or process termination.
 * Only LOCK_BUSY is retried; corrupt, unsafe or unauthenticated roots fail. */
export async function withNativeStorageRootLock<T>(runtimePackage: VerifiedRuntimePackage,
  rootPath: string, name: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const instance = `storage-lock:${randomUUID()}`;
  const rootId = 'native-storage-authority';
  const owner = loadNativeHostBridge(runtimePackage).openNativeSessionStoreBridge(instance, rootId, rootPath, 64 * 1024);
  const client = new NativeSessionStoreBridgeClient(owner, instance, () => BigInt(Date.now()), 5_000n);
  let handle: string | undefined;
  try {
    for (let attempt = 0; attempt < 500; attempt++) {
      signal?.throwIfAborted();
      try {
        const response = await client.request({ case: 'acquireStorageRootLock',
          value: create(wire.AcquireStorageRootLockSchema, { rootId, lockName: name }) });
        if (response.case !== 'storageRootLockAcquired' || !response.value.lockHandle) {
          throw new Error('Native storage lock response diverged');
        }
        handle = response.value.lockHandle;
        break;
      } catch (cause) {
        if (!(cause instanceof NativeSessionStoreRequestError) || cause.failure.code !== wire.SessionStoreFailureCode.LOCK_BUSY) throw cause;
        await delay(10, undefined, { signal });
      }
    }
    if (!handle) throw new Error('Native storage authority remained busy');
    signal?.throwIfAborted();
    return await operation();
  } finally {
    try {
      if (handle) await client.request({ case: 'releaseStorageRootLock',
        value: create(wire.ReleaseStorageRootLockSchema, { lockHandle: handle }) });
    } finally { await client.close(); }
  }
}
