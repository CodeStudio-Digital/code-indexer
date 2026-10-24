import { NativeDurableEngineEventCommitter } from './NativeDurableEngineEventCommitter.js';
import { prepareNativeSupervisorOutbox } from './NativeSupervisorOutbox.js';
import type { NativeRustHostAttemptRuntimeOptions } from './NativeRustHostAttemptRuntimeTypes.js';

/** Recover and populate the writer without a live process waiting for Hello. */
export async function prepareNativeRuntimeSession(
  options: NativeRustHostAttemptRuntimeOptions,
  signal?: AbortSignal,
): Promise<{ sessionStore?: NativeDurableEngineEventCommitter; lifecycleOutboxDirectory?: string }> {
  let sessionStore: NativeDurableEngineEventCommitter | undefined;
  try {
    signal?.throwIfAborted();
    if (options.sessionStore && options.data.engineEventCommitter) {
      throw new Error('native session store authority is ambiguous');
    }
    if (options.sessionStoreReady && !options.sessionStore) {
      throw new Error('native session preparation requires a session store');
    }
    // Journal recovery and attachment copies can outlive the supervisor's
    // Hello timeout. Complete both before opening its handshake window.
    sessionStore = options.sessionStore
      ? await NativeDurableEngineEventCommitter.open(options.binding, options.sessionStore)
      : undefined;
    signal?.throwIfAborted();
    if (sessionStore) await options.sessionStoreReady?.(sessionStore);
    signal?.throwIfAborted();
    const lifecycleOutboxDirectory = await prepareNativeSupervisorOutbox(
      options.sessionStore?.rootPath, options.supervisor.expectedConnectionId,
    );
    signal?.throwIfAborted();
    // Preparation cannot renew the lease or extend the original opening grant.
    if (options.supervisor.nowUnixMs() >= options.openDeadlineAtUnixMs) {
      throw new Error('native attempt opening authority expired during preparation');
    }
    return { sessionStore, lifecycleOutboxDirectory };
  } catch (cause) {
    await sessionStore?.close().catch(() => undefined);
    throw cause;
  }
}
