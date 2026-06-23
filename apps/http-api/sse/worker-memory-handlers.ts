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
import type { MemoryRetriever } from '@mcp/services/memory/retriever.js';
import type { RunEndMemory } from '@mcp/services/memory/run-end.js';

export interface WorkerMemoryDeps {
  memoryRetriever?: MemoryRetriever | null;
  runEndMemory?: RunEndMemory | null;
  /** Direct project-memory ports (save_note scope 'project' + recall_memory).
   *  Structural mirror of `RunCoderOptions.projectMemory` (host impl in deps.ts). */
  projectMemory?: {
    save(
      projectId: number,
      projectName: string,
      entry: { title: string; content: string; category: string },
    ): Promise<{ created: number; merged: number; skipped: number } | null>;
    recall(
      projectId: number,
      projectName: string,
      query: string,
      limit?: number,
    ): Promise<Array<{
      id: string; title: string; content: string;
      category?: string; source?: string; importance?: number; staleNote?: string;
    }>>;
  } | null;
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

/**
 * Register the three memory handlers on a worker bridge. Returns a single
 * disposer that detaches all of them (call it from the pool's
 * `detachBusMirror`).
 */
export function registerWorkerMemoryHandlers(
  bridge: BridgeLike,
  getDeps: () => WorkerMemoryDeps | undefined,
): () => void {
  const offRetrieve = bridge.handle('memoryRetrieve', async (payload) => {
    const retriever = getDeps()?.memoryRetriever;
    if (!retriever) return [];
    const { projectId, projectName, taskText } = payload as RetrievePayload;
    return retriever.retrieve(projectId, projectName, taskText);
  });

  const offExtract = bridge.handle('memoryExtract', async (payload) => {
    const runEnd = getDeps()?.runEndMemory;
    if (!runEnd) return undefined;
    const { projectId, projectName, input } = payload as ExtractPayload;
    // Pass the aggregate counts back so worker-side callers (harvest) can
    // observe what landed; older shims simply ignore the value.
    return (await runEnd.extractAndPersist(projectId, projectName, input)) ?? undefined;
  });

  const offIsConfigured = bridge.handle('memoryIsConfigured', async () => {
    const runEnd = getDeps()?.runEndMemory;
    if (!runEnd) return false;
    return runEnd.isConfigured();
  });

  const offSave = bridge.handle('memorySave', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm) return null;
    const { projectId, projectName, entry } = payload as {
      projectId: number; projectName: string;
      entry: { title: string; content: string; category: string };
    };
    return pm.save(projectId, projectName, entry);
  });

  const offRecall = bridge.handle('memoryRecall', async (payload) => {
    const pm = getDeps()?.projectMemory;
    if (!pm) return [];
    const { projectId, projectName, query, limit } = payload as {
      projectId: number; projectName: string; query: string; limit?: number;
    };
    return pm.recall(projectId, projectName, query, limit);
  });

  return (): void => {
    try { offRetrieve(); } catch { /* best-effort */ }
    try { offExtract(); } catch { /* best-effort */ }
    try { offIsConfigured(); } catch { /* best-effort */ }
    try { offSave(); } catch { /* best-effort */ }
    try { offRecall(); } catch { /* best-effort */ }
  };
}
