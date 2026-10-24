import { toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact, agentV1Common, type agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { HostHydrationSource, HostHydrationReference } from '../ipc/HostDataHydration.js';
import { nativePrepareAttempt } from './NativeAttemptProvisioning.js';

/** Order detached product material exactly as the admitted manifest. Unknown,
 * duplicate or changed references fail before the physical launch. */
export function composeNativeHydrationSources(spec: agentV1Runtime.ResolvedAttemptSpec,
  sources: readonly HostHydrationSource[]): HostHydrationSource {
  sources = [...sources];
  const expected: HostHydrationReference[] = [
    ...nativePrepareAttempt(spec).expectedSnapshots.map((value) => ({ case: 'snapshot' as const, value })),
    ...[spec.task?.body.case === 'artifact' ? spec.task.body.value : undefined, ...(spec.task?.attachments ?? []),
      spec.checkpointInput, spec.transcriptInput].filter((value) => value !== undefined)
      .map((value) => ({ case: 'artifact' as const, value })),
  ];
  const available = new Map<string, { source: HostHydrationSource; ordinal: number;
    reference: HostHydrationReference; byteLength: bigint }>();
  for (const source of sources) for (const [ordinal, item] of source.items.entries()) {
    const key = referenceKey(item.reference);
    if (available.has(key) || available.size >= 10_000 || item.byteLength <= 0n) {
      throw new Error('Native hydration material is duplicate, empty or excessive');
    }
    available.set(key, { source, ordinal, reference: structuredClone(item.reference), byteLength: item.byteLength });
  }
  if (available.size !== expected.length) throw new Error('Native hydration material does not match its admitted manifest');
  const ordered = expected.map((reference) => {
    const entry = available.get(referenceKey(reference));
    if (!entry || !Buffer.from(encode(reference)).equals(encode(entry.reference))) {
      throw new Error('Native hydration reference differs from its admitted manifest');
    }
    return entry;
  });
  let closed = false;
  return { items: ordered.map(({ reference, byteLength }) => ({ reference: structuredClone(reference), byteLength })),
    readExact(ordinal, offset, length, signal) {
      signal?.throwIfAborted(); const entry = ordered[ordinal];
      if (closed || !entry || !Number.isSafeInteger(ordinal)) throw new Error('Native hydration source is unavailable');
      return entry.source.readExact(entry.ordinal, offset, length, signal);
    },
    async close(cause) {
      if (closed) return; closed = true;
      const outcomes = await Promise.allSettled(sources.map((source) => Promise.resolve().then(() => source.close(cause))));
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}

function referenceKey(reference: HostHydrationReference) {
  return reference.case === 'snapshot' ? `snapshot:${reference.value.ref}` : `artifact:${reference.value.artifactId}`;
}
function encode(reference: HostHydrationReference) {
  return reference.case === 'snapshot' ? toBinary(agentV1Common.SnapshotRefSchema, reference.value)
    : toBinary(agentV1Artifact.ArtifactRefSchema, reference.value);
}
