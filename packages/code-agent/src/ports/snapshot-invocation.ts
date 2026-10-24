import { AsyncLocalStorage } from 'node:async_hooks';

interface SnapshotInvocation { toolUseId: string | undefined; toolName: string }
const invocation = new AsyncLocalStorage<SnapshotInvocation>();

/** The recording port is shared, so invocation identity must never be a mutable tag. */
export function runWithSnapshotInvocation<T>(identity: SnapshotInvocation, operation: () => T): T {
  return invocation.run(identity, operation);
}

export function currentSnapshotInvocation(): SnapshotInvocation | undefined {
  return invocation.getStore();
}
