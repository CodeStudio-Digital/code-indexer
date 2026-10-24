import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { SemanticMutation, SemanticMutationFence, SemanticMutationSink } from '../semantic-mutation-sink.js';

interface MemoryMutationBatch {
  /** One identity-discovery fence covers every INSERT in this namespace. */
  identityFences: Map<string, SemanticMutationFence>;
  /** Exact delete/update fences are kept separate, then settled in one tick. */
  targetedFences: SemanticMutationFence[];
  mutationError: unknown;
}

export interface AgentMemoryMutationExecution {
  /**
   * Execute one synchronous relational/fence section. Electron-main supplies a
   * fail-fast busy-timeout wrapper; workers/tests use the direct default.
   */
  execute<T>(operation: () => T): T;
  /**
   * Optional async contention queue for batch settlement. It retries only the
   * small synchronous callback and never holds the event loop while waiting.
   */
  retry?<T>(operation: () => T): Promise<T>;
}

/** Serializes relational writes and settles their durable semantic fences. */
export class MemoryMutationCoordinator {
  private readonly mutationBatch = new AsyncLocalStorage<MemoryMutationBatch>();
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutationBatches = 0;
  constructor(
    private readonly db: CodeIndexDB,
    private readonly semanticMutationSink: SemanticMutationSink | null,
    private readonly mutationExecution: AgentMemoryMutationExecution,
  ) {}

  commitRelationalMutation<T>(
    inputs: readonly SemanticMutation[],
    mutation: () => T,
  ): T {
    return this.mutationExecution.execute(() => {
      const atomic = () => this.commitRelationalMutationNow(inputs, mutation);
      // The durable fence store and agent_memory use the same central
      // connection in every production composition. Keep fence start, source
      // mutation, and fence settlement in one outer transaction so an async
      // SQLITE_BUSY retry can never replay a partially committed memory save.
      // Test/lightweight adapters that do not expose transaction retain the
      // original ordered contract.
      return typeof this.db.transaction === 'function'
        ? this.db.transaction(atomic)
        : atomic();
    });
  }

  private commitRelationalMutationNow<T>(
    inputs: readonly SemanticMutation[],
    mutation: () => T,
  ): T {
    const canFence = typeof this.semanticMutationSink?.beginMutation === 'function'
      && typeof this.semanticMutationSink?.settleMutation === 'function';
    const batch = canFence ? this.mutationBatch.getStore() : undefined;
    if (batch) {
      try {
        for (const input of inputs) {
          const exactKeys = input.itemKeys.filter((key) => key !== '*');
          if (input.itemKeys.includes('*') && !batch.identityFences.has(input.namespace)) {
            const fence = this.semanticMutationSink!.beginMutation!({
              namespace: input.namespace,
              itemKeys: ['*'],
              // Identity discovery is source-truth reconciliation. Keep it an
              // upsert fence even if the caller also has exact delete keys, so
              // a later INSERT in the same async batch cannot be filtered out.
              operation: 'upsert',
            });
            if (fence) batch.identityFences.set(input.namespace, fence);
          }
          if (exactKeys.length > 0) {
            const fence = this.semanticMutationSink!.beginMutation!({
              namespace: input.namespace,
              itemKeys: exactKeys,
              operation: input.operation,
            });
            if (fence) batch.targetedFences.push(fence);
          }
        }
        return mutation();
      } catch (error) {
        batch.mutationError ??= error;
        throw error;
      }
    }

    const fences: SemanticMutationFence[] = [];
    if (canFence) {
      try {
        for (const input of inputs) {
          const fence = this.semanticMutationSink!.beginMutation!(input);
          if (fence) fences.push(fence);
        }
      } catch (error) {
        for (const fence of fences) {
          try { this.semanticMutationSink!.settleMutation!(fence, error); } catch { /* recovery owns it */ }
        }
        throw error;
      }
    }

    let result!: T;
    try {
      result = mutation();
    } catch (error) {
      for (const fence of fences) {
        try { this.semanticMutationSink!.settleMutation!(fence, error); } catch { /* preserve mutation error */ }
      }
      throw error;
    }

    if (canFence) {
      for (const fence of fences) this.semanticMutationSink!.settleMutation!(fence);
    } else {
      for (const input of inputs) this.semanticMutationSink?.noteMutation(input);
    }
    return result;
  }

  /**
   * Coalesce a logical extraction pass without weakening the pre-write
   * activation barrier. INSERTs share one identity-discovery fence per
   * namespace; exact archive/replace keys remain durable fences of their own.
   * Every fence settles synchronously at the end, so the HTTP drain scheduler
   * observes one namespace wake-up instead of one full pass per learned fact.
   */
  async runMutationBatch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.mutationBatch.getStore()) return operation();
    if (this.pendingMutationBatches >= 64) throw new Error('Memory mutation queue is full');
    this.pendingMutationBatches++;
    // Dedupe and persistence share one owner. Serializing only the INSERT
    // lets concurrent callers both observe "absent" and create two memories.
    const result = this.mutationTail.then(() => this.runOwnedMutationBatch(operation));
    this.mutationTail = result.then(() => undefined, () => undefined);
    try { return await result; } finally { this.pendingMutationBatches--; }
  }

  private async runOwnedMutationBatch<T>(operation: () => Promise<T>): Promise<T> {
    const batch: MemoryMutationBatch = {
      identityFences: new Map(),
      targetedFences: [],
      mutationError: null,
    };
    let result!: T;
    let operationError: unknown = null;
    try {
      result = await this.mutationBatch.run(batch, operation);
    } catch (error) {
      operationError = error;
      batch.mutationError ??= error;
    }

    let settleError: unknown = null;
    const fences = [
      ...batch.identityFences.values(),
      ...batch.targetedFences,
    ];
    for (const fence of fences) {
      try {
        const settle = () =>
          this.mutationExecution.execute(() =>
            this.semanticMutationSink!.settleMutation!(fence, batch.mutationError));
        if (this.mutationExecution.retry) await this.mutationExecution.retry(settle);
        else settle();
      } catch (error) {
        settleError ??= error;
      }
    }
    if (operationError) throw operationError;
    if (settleError) throw settleError;
    return result;
  }

  get hasDurableMutationQueue(): boolean {
    return typeof this.semanticMutationSink?.beginMutation === 'function'
      && typeof this.semanticMutationSink?.settleMutation === 'function';
  }

  /**
   * Run an arbitrary central-memory SQLite section through the same fail-fast
   * adapter and async contention queue as normal agent-memory mutations.
   *
   * Background maintenance runs in Electron main and also updates session/log
   * tables on the shared connection. Keeping this seam public lets those
   * callers wait for SQLITE_BUSY without blocking the main event loop.
   */
  async runRelationalWrite<T>(operation: () => T): Promise<T> {
    const attempt = (): T => this.mutationExecution.execute(operation);
    return this.mutationExecution.retry
      ? this.mutationExecution.retry(attempt)
      : attempt();
  }
}
