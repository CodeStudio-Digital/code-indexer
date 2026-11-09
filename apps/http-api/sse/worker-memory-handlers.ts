/**
 * Main-side bridge handlers for project memory (Mem C across workers).
 *
 * The canonical `MemoryRetriever` + `RunEndMemory` live ONCE in the main
 * process (`server/deps.ts`) — they own the embedding backend, hybrid
 * search, dedup and the `memory_extraction` provider binding. Workers
 * (coder-worker + company-worker) install thin shims
 * (`workers/memory-shims.ts`) that RPC here via MessageBridge.
 *
 * Registered per worker spawn by `CoderWorkerPool` / `WorkerOrchestratorPool`
 * next to the docSearch/vision handlers. Deps are read through a getter at
 * call time (mutable deps-box pattern) so wiring that lands after the first
 * spawn still reaches every worker.
 *
 * Failure posture: memory must never break a run — missing deps degrade to
 * empty retrieval / skipped distillation instead of throwing.
 */
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';
import type { LiteralMemoryEntry } from '@mcp/shared/memory-write.js';
import type { InvestigationSemanticIndexPort } from '@mcp/code-agent/tools/investigation-embedder.js';
import { timeCall } from '../server/perf/slow-ipc.js';
import { WorkerMemoryReads } from './worker-memory-reads.js';

export interface WorkerMemoryDeps {
  /** Structural project-memory retrieval port (agent_memory-backed in deps.ts). */
  memoryRetriever?: {
    recordInjected?(ids: readonly string[]): void | Promise<void>;
    retrieve(
      projectId: number,
      projectName: string,
      taskText: string,
    ): Promise<ReadonlyArray<{ id: string; title: string; content: string; importance?: number; staleNote?: string }>>;
  } | null;
  /** Smart memory-recall query synthesizer (meta message → real query). Null
   *  when unconfigured; the worker shim degrades to null (runner uses heuristic). */
  memoryQuerySynthesizer?:
    | ((tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>) => Promise<string | null>)
    | null;
  runEndMemory?: RunEndMemory | null;
  /** Direct project-memory ports (save_note scope 'project' + recall_memory).
   *  Structural mirror of `RunCoderOptions.projectMemory` (host impl in deps.ts). */
  projectMemory?: {
    save(
      projectId: number,
      projectName: string,
      entry: LiteralMemoryEntry,
      control?: import('@mcp/services/memory/mutation-control.js').MemoryMutationControl,
    ): Promise<{ created: number; merged: number; skipped: number } | null>;
    recall(
      projectId: number,
      projectName: string,
      query: string,
      limit?: number,
      signal?: AbortSignal,
    ): Promise<Array<{
      id: string; title: string; content: string;
      category?: string; source?: string; importance?: number; staleNote?: string;
    }>>;
    list?(
      projectId: number,
      projectName: string,
      limit?: number,
      type?: string,
      signal?: AbortSignal,
    ): Promise<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>;
    forget?(
      projectId: number,
      projectName: string,
      target: string,
      control?: import('@mcp/services/memory/mutation-control.js').MemoryMutationControl,
    ): Promise<{ archived: number }>;
  } | null;
  /** Session Drive calls stay main-side as orchestration; vector I/O is
   * delegated through the semantic worker-owned store. */
  investigationSemantic?: InvestigationSemanticIndexPort | null;
}

/** Minimal structural slice of MessageBridge used here (test-friendly). */
interface BridgeLike {
  handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void;
}

interface RetrievePayload {
  projectId: number;
  projectName: string;
  taskText: string;
}

interface ExtractPayload {
  projectId: number;
  projectName: string;
  input: Parameters<RunEndMemory['extractAndPersist']>[2];
}

type MemorySaveResult = { created: number; merged: number; skipped: number };
type MemorySaveOperation =
  | { state: 'pending'; promise: Promise<MemorySaveResult>; updatedAt: number }
  | { state: 'completed'; result: MemorySaveResult; updatedAt: number }
  | { state: 'failed'; error: string; code?: string; updatedAt: number };

const MEMORY_SAVE_OPERATION_TTL_MS = 5 * 60_000;
const MEMORY_SAVE_OPERATION_LIMIT = 512;
const memorySaveOperations = new Map<string, MemorySaveOperation>();
type MemoryForgetResult = { archived: number };
type MemoryForgetOperation =
  | { state: 'pending'; promise: Promise<MemoryForgetResult>; updatedAt: number }
  | { state: 'completed'; result: MemoryForgetResult; updatedAt: number }
  | { state: 'failed'; error: string; code?: string; updatedAt: number };
const memoryForgetOperations = new Map<string, MemoryForgetOperation>();

function operationError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function pruneMemorySaveOperations(now = Date.now()): void {
  for (const [id, operation] of memorySaveOperations) {
    if (operation.state !== 'pending' && now - operation.updatedAt > MEMORY_SAVE_OPERATION_TTL_MS) {
      memorySaveOperations.delete(id);
    }
  }
  if (memorySaveOperations.size <= MEMORY_SAVE_OPERATION_LIMIT) return;
  for (const [id, operation] of memorySaveOperations) {
    if (operation.state === 'pending') continue;
    memorySaveOperations.delete(id);
    if (memorySaveOperations.size <= MEMORY_SAVE_OPERATION_LIMIT) break;
  }
}

function runMemorySaveOperation(
  operationId: string,
  save: () => Promise<MemorySaveResult | null>,
): Promise<MemorySaveResult> {
  pruneMemorySaveOperations();
  const existing = memorySaveOperations.get(operationId);
  if (existing?.state === 'pending') return existing.promise;
  if (existing?.state === 'completed') return Promise.resolve(existing.result);
  if (existing?.state === 'failed') {
    return Promise.reject(operationError(existing.error, existing.code ?? 'memory_save_failed'));
  }

  const promise = timeCall('worker-rpc:memorySave', async () => {
    const result = await save();
    if (!result) throw operationError('Project memory persistence is unavailable', 'memory_unavailable');
    return result;
  });
  memorySaveOperations.set(operationId, { state: 'pending', promise, updatedAt: Date.now() });
  void promise.then(
    (result) => {
      memorySaveOperations.set(operationId, { state: 'completed', result, updatedAt: Date.now() });
    },
    (error: unknown) => {
      memorySaveOperations.set(operationId, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(
          typeof (error as { code?: unknown } | null)?.code === 'string'
            ? { code: (error as { code: string }).code }
            : {}
        ),
        updatedAt: Date.now(),
      });
    },
  );
  return promise;
}

export function clearMemorySaveOperationRegistryForTests(): void {
  memorySaveOperations.clear();
  memoryForgetOperations.clear();
}

function runMemoryForgetOperation(
  operationId: string,
  forget: () => Promise<MemoryForgetResult>,
): Promise<MemoryForgetResult> {
  const now = Date.now();
  for (const [id, operation] of memoryForgetOperations) {
    if (operation.state !== 'pending' && now - operation.updatedAt > MEMORY_SAVE_OPERATION_TTL_MS) {
      memoryForgetOperations.delete(id);
    }
  }
  const existing = memoryForgetOperations.get(operationId);
  if (existing?.state === 'pending') return existing.promise;
  if (existing?.state === 'completed') return Promise.resolve(existing.result);
  if (existing?.state === 'failed') {
    return Promise.reject(operationError(existing.error, existing.code ?? 'memory_forget_failed'));
  }
  if (memoryForgetOperations.size >= MEMORY_SAVE_OPERATION_LIMIT) {
    for (const [id, operation] of memoryForgetOperations) {
      if (operation.state === 'pending') continue;
      memoryForgetOperations.delete(id);
      break;
    }
  }

  const promise = timeCall('worker-rpc:memoryForget', forget);
  memoryForgetOperations.set(operationId, { state: 'pending', promise, updatedAt: now });
  void promise.then(
    (result) => {
      memoryForgetOperations.set(operationId, { state: 'completed', result, updatedAt: Date.now() });
    },
    (error: unknown) => {
      memoryForgetOperations.set(operationId, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(
          typeof (error as { code?: unknown } | null)?.code === 'string'
            ? { code: (error as { code: string }).code }
            : {}
        ),
        updatedAt: Date.now(),
      });
    },
  );
  return promise;
}

/**
 * Register the three memory handlers on a worker bridge. Returns a single
 * disposer that detaches all of them (call it from the pool's
 * `detachBusMirror`).
 */
export function registerWorkerMemoryHandlers(
  bridge: BridgeLike,
  getDeps: () => WorkerMemoryDeps | undefined,
): () => void {
  const reads = new WorkerMemoryReads();
  const offReadCancel = bridge.handle('memoryReadCancel', async payload => {
    reads.cancel((payload as { readId?: unknown })?.readId);
  });
  const offRetrieve = bridge.handle('memoryRetrieve', async (payload) => {
    const retriever = getDeps()?.memoryRetriever;
    if (!retriever) return [];
    const { projectId, projectName, taskText } = payload as RetrievePayload;
    return timeCall('worker-rpc:memoryRetrieve', () =>
      retriever.retrieve(projectId, projectName, taskText));
  });
  const offInjected = bridge.handle('memoryInjected', async payload => {
    const ids = (payload as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[1-9]\d*$/.test(id))) return;
    await getDeps()?.memoryRetriever?.recordInjected?.(ids);
  });

  const offQuerySynth = bridge.handle('memoryQuerySynth', async (payload) => {
    const synth = getDeps()?.memoryQuerySynthesizer;
    if (!synth) return null;
    const { tail } = payload as { tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> };
    return synth(tail);
  });

  const offExtract = bridge.handle('memoryExtract', async (payload) => {
    const runEnd = getDeps()?.runEndMemory;
    if (!runEnd) return undefined;
    const { projectId, projectName, input } = payload as ExtractPayload;
    // Pass the aggregate counts back so worker-side callers (harvest) can
    // observe what landed; older shims simply ignore the value.
    return timeCall(
      'worker-rpc:memoryExtract',
      async () => (await runEnd.extractAndPersist(projectId, projectName, input)) ?? undefined,
    );
  });

  const offIsConfigured = bridge.handle('memoryIsConfigured', async () => {
    const runEnd = getDeps()?.runEndMemory;
    if (!runEnd) return false;
    return runEnd.isConfigured();
  });

  const offSave = bridge.handle('memorySave', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm) throw operationError('Project memory persistence is unavailable', 'memory_unavailable');
    const { operationId, projectId, projectName, entry } = payload as {
      operationId: string;
      projectId: number; projectName: string;
      entry: { title: string; content: string; category: string };
    };
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(operationId)) {
      throw operationError('memorySave requires a valid operationId', 'invalid_operation_id');
    }
    return runMemorySaveOperation(
      operationId,
      () => pm.save(projectId, projectName, entry),
    );
  });

  const offSaveStatus = bridge.handle('memorySaveStatus', async (payload) => {
    const { operationId } = payload as { operationId?: unknown };
    if (typeof operationId !== 'string') return { state: 'unknown' };
    pruneMemorySaveOperations();
    const operation = memorySaveOperations.get(operationId);
    if (!operation) return { state: 'unknown' };
    if (operation.state === 'pending') return { state: 'pending' };
    if (operation.state === 'completed') return { state: 'completed', result: operation.result };
    return {
      state: 'failed',
      error: operation.error,
      ...(operation.code ? { code: operation.code } : {}),
    };
  });

  const offRecall = bridge.handle('memoryRecall', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm) return [];
    const { projectId, projectName, query, limit, readId } = payload as {
      projectId: number; projectName: string; query: string; limit?: number; readId?: string;
    };
    return reads.run(readId, signal => timeCall('worker-rpc:memoryRecall', () =>
      pm.recall(projectId, projectName, query, limit, signal)));
  });

  const offList = bridge.handle('memoryList', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm?.list) return [];
    const { projectId, projectName, limit, type, readId } = payload as {
      projectId: number; projectName: string; limit?: number; type?: string; readId?: string;
    };
    return reads.run(readId, signal => pm.list!(projectId, projectName, limit, type, signal));
  });

  const offForget = bridge.handle('memoryForget', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm?.forget) throw operationError('Project memory persistence is unavailable', 'memory_unavailable');
    const { operationId, projectId, projectName, target } = payload as {
      operationId: string; projectId: number; projectName: string; target: string;
    };
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(operationId)) {
      throw operationError('memoryForget requires a valid operationId', 'invalid_operation_id');
    }
    return runMemoryForgetOperation(
      operationId,
      () => pm.forget!(projectId, projectName, target),
    );
  });

  const offForgetStatus = bridge.handle('memoryForgetStatus', async (payload) => {
    const { operationId } = payload as { operationId?: unknown };
    if (typeof operationId !== 'string') return { state: 'unknown' };
    const operation = memoryForgetOperations.get(operationId);
    if (!operation) return { state: 'unknown' };
    if (operation.state === 'pending') return { state: 'pending' };
    if (operation.state === 'completed') return { state: 'completed', result: operation.result };
    return {
      state: 'failed',
      error: operation.error,
      ...(operation.code ? { code: operation.code } : {}),
    };
  });

  const offInvestigationSearch = bridge.handle('investigationSearch', async (payload) => {
    const semantic = getDeps()?.investigationSemantic;
    if (!semantic) return [];
    const { readId, ...input } = payload as Parameters<InvestigationSemanticIndexPort['search']>[0] & { readId?: string };
    return reads.run(readId, signal => semantic.search(input, signal));
  });

  const offInvestigationWake = bridge.handle('investigationWake', async (payload) => {
    const semantic = getDeps()?.investigationSemantic;
    if (semantic) semantic.wakeUpsert(
      payload as Parameters<InvestigationSemanticIndexPort['wakeUpsert']>[0],
    );
    return undefined;
  });

  return (): void => {
    reads.close();
    offReadCancel();
    try { offRetrieve(); } catch { /* best-effort */ }
    try { offInjected(); } catch { /* best-effort */ }
    try { offQuerySynth(); } catch { /* best-effort */ }
    try { offExtract(); } catch { /* best-effort */ }
    try { offIsConfigured(); } catch { /* best-effort */ }
    try { offSave(); } catch { /* best-effort */ }
    try { offSaveStatus(); } catch { /* best-effort */ }
    try { offRecall(); } catch { /* best-effort */ }
    try { offList(); } catch { /* best-effort */ }
    try { offForget(); } catch { /* best-effort */ }
    try { offForgetStatus(); } catch { /* best-effort */ }
    try { offInvestigationSearch(); } catch { /* best-effort */ }
    try { offInvestigationWake(); } catch { /* best-effort */ }
  };
}
