import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeSessionStoreRequestError } from '@mcp/agent-runtime-host';

export function isNativeSnapshotChanged(error: unknown): boolean {
  return error instanceof NativeSessionStoreRequestError
    && error.failure.code === wire.SessionStoreFailureCode.CONCURRENT_MUTATION
    && error.failure.reasonCode === 'concurrent_session_mutation';
}

/** Retry only a read snapshot invalidated by a concurrent commit. Never retry
 * writer operations, reuse a partial projection or hide integrity failures. */
export async function readNativeHistorySnapshot<T, R extends {
  assertCurrent(): Promise<void>; close(): Promise<void>;
}>(open: () => Promise<R>, project: (reader: R) => Promise<T>): Promise<{ reader: R; value: T }> {
  for (let attempt = 0; ; attempt++) {
    let reader: R | undefined;
    try {
      reader = await open();
      const value = await project(reader);
      await reader.assertCurrent();
      return { reader, value };
    } catch (error) {
      await reader?.close().catch(() => undefined);
      if (!isNativeSnapshotChanged(error) || attempt >= 2) throw error;
      await yieldToEventLoop();
    }
  }
}
