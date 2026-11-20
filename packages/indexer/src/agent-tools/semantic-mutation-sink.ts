import {
  semanticPurposeForNamespace,
  type SemanticStore,
} from '@mcp/store/semantic-store.js';
import {
  createDurableSemanticMutationSink,
  type SemanticMutationSink,
} from '@mcp/services/semantic-mutation-sink.js';

/** Durable sink used by save_memory and any future index snapshot writer.
 * The namespace delta/fence is the complete crash-safe hand-off. It never
 * emits a profile-wide reindex wake-up; an active namespace can be reconciled
 * by a targeted owner wake, while a generation-less namespace waits for the
 * operator's explicit first build. Without `wake` (a process with no owner to
 * wake) the durable job still lands and is reconciled on the next wake. */
export function createMcpSemanticMutationSink(
  semanticStore: SemanticStore,
  options: {
    wake?: (namespace: string) => void | Promise<void>;
  } = {},
): SemanticMutationSink {
  return createDurableSemanticMutationSink(semanticStore, {
    owner: `mcp:${process.pid}:${Math.random().toString(16).slice(2)}`,
    enabled: (namespace) => semanticStore.getProfile(
      semanticPurposeForNamespace(namespace),
    )?.embedding_target.kind !== 'disabled',
    // Do not wake the profile-wide reindex endpoint here. The targeted owner
    // wake reconciles only an already-active namespace; generation-less
    // namespaces still wait for an explicit first build.
    onDurableMutation: (namespace, phase) => {
      if (phase === 'started') return;
      return options.wake?.(namespace);
    },
  });
}
