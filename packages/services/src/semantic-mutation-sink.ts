import { randomUUID } from 'node:crypto';
import type {
  SemanticMutationInput,
  SemanticStore,
} from '@mcp/store/semantic-store.js';

/** Opaque handle proving that durable catch-up was fenced before the
 * relational source changed. Services never inspect the control-plane job. */
export interface SemanticMutationFence {
  jobId: number;
  token: string;
  namespace: string;
}

export type SemanticMutation = Omit<SemanticMutationInput, 'fence'>;

/**
 * Application-facing port for durable semantic catch-up.
 *
 * `beginMutation`/`settleMutation` close the activation race for relational
 * writers: a running durable job exists before SQLite changes and remains a
 * barrier until the writer's `finally` block settles it. `noteMutation` stays
 * available for callers whose mutation is already atomic with their own
 * watermark (watcher deltas, bulk reconciliation, and legacy integrations).
 */
export interface SemanticMutationSink {
  noteMutation(input: SemanticMutation): void;
  beginMutation?(input: SemanticMutation): SemanticMutationFence | null;
  settleMutation?(fence: SemanticMutationFence, mutationError?: unknown): void;
}

export const NULL_SEMANTIC_MUTATION_SINK: SemanticMutationSink = {
  noteMutation: () => undefined,
};

export interface DurableSemanticMutationSinkOptions {
  /** Stable for this sink instance and unique across processes. */
  owner?: string;
  /** Cross-process fences are recovered only after this lease expires. */
  leaseMs?: number;
  enabled?: () => boolean;
  /** Best-effort wake-up; durability has already landed when this runs. */
  onDurableMutation?: (
    namespace: string,
    phase: 'noted' | 'started' | 'settled',
  ) => void | Promise<void>;
}

function errorMessage(error: unknown): string | null {
  if (error == null) return null;
  return error instanceof Error ? error.message : String(error);
}

/** Build a real central-control-plane sink without exposing SemanticStore to
 * SnapshotService/AgentMemoryService. The callback is deliberately fail-open:
 * HTTP wake-up affects latency only, while the SQLite job is authoritative. */
export function createDurableSemanticMutationSink(
  store: Pick<SemanticStore,
    'noteNamespaceMutation' | 'settleNamespaceMutationFence'>,
  options: DurableSemanticMutationSinkOptions = {},
): SemanticMutationSink {
  const owner = options.owner?.trim()
    || `semantic-writer:${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);
  const enabled = options.enabled ?? (() => true);
  const notify = (namespace: string, phase: 'noted' | 'started' | 'settled'): void => {
    try {
      const result = options.onDurableMutation?.(namespace, phase);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A missed wake-up only delays targeted reconciliation until another
      // explicit wake or watcher event; never roll back a durable job merely
      // because localhost HTTP is unavailable.
    }
  };

  return {
    noteMutation: (input) => {
      if (!enabled()) return;
      store.noteNamespaceMutation(input);
      notify(input.namespace, 'noted');
    },
    beginMutation: (input) => {
      if (!enabled()) return null;
      const token = randomUUID();
      const job = store.noteNamespaceMutation({
        ...input,
        fence: { token, owner, leaseMs },
      });
      notify(input.namespace, 'started');
      return { jobId: job.id, token, namespace: input.namespace };
    },
    settleMutation: (fence, mutationError) => {
      store.settleNamespaceMutationFence({
        job_id: fence.jobId,
        token: fence.token,
        mutation_error: errorMessage(mutationError),
      });
      notify(fence.namespace, 'settled');
    },
  };
}
