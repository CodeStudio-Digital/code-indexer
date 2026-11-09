import { createHash } from 'node:crypto';
import type { CoderAttemptAdmissionV1, CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';
import type { ToolRegistry } from '../core/registry.js';
import type { CoderTool } from '../core/tool.js';
import { resolveCapabilitySet } from '../core/capability-catalog.js';

/** The same canonical JSON convention as capability-catalog and the host ledger. */
export function preparationSha256(value: CoderAttemptPreparationV1): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .filter(([, item]) => item !== undefined).map(([key, item]) => [key, sort(item)]));
    }
    return entry;
  };
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

export function prepareCoderAttempt(
  input: Omit<CoderAttemptPreparationV1, 'schemaVersion' | 'capabilitySet' | 'capabilityDescriptors'>,
  registry: ToolRegistry,
  catalogOnly: readonly CoderTool[] = [],
): CoderAttemptPreparationV1 {
  if (!registry.isSealed) throw new Error('Attempt preparation requires a sealed tool registry');
  const { set, descriptors } = resolveCapabilitySet([...registry.list(), ...catalogOnly], {
    agentRunId: input.agentRunId,
  });
  // Detach mutable tool schemas and policy objects before crossing an async boundary.
  return JSON.parse(JSON.stringify({ ...input, schemaVersion: 1,
    capabilitySet: set, capabilityDescriptors: descriptors })) as CoderAttemptPreparationV1;
}

export async function admitCoderAttempt(
  preparation: CoderAttemptPreparationV1,
  admit: (facts: CoderAttemptPreparationV1) => Promise<CoderAttemptAdmissionV1>,
  signal?: AbortSignal,
): Promise<CoderAttemptAdmissionV1> {
  signal?.throwIfAborted();
  const expectedDigest = preparationSha256(preparation);
  const pending = admit(preparation);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let receipt: CoderAttemptAdmissionV1;
  try {
    receipt = await Promise.race([pending, cancelled]);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  signal?.throwIfAborted();
  if (receipt.schemaVersion !== 1 || receipt.sessionId !== preparation.sessionId
    || receipt.agentRunId !== preparation.agentRunId || receipt.runtimeGeneration !== 'legacy_ts'
    || receipt.preparationSha256 !== expectedDigest || !receipt.preparationRef
    || !receipt.attemptId || !receipt.executorOwnerId
    || !Number.isSafeInteger(receipt.fencingEpoch) || receipt.fencingEpoch <= 0) {
    throw new Error('Attempt admission receipt does not match the prepared legacy execution');
  }
  return receipt;
}
