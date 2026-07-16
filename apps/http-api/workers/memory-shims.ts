/**
 * Worker-side project-memory shims (Mem C across worker_threads).
 *
 * `worker_threads` don't share module state, so the canonical
 * `MemoryRetriever` + `RunEndMemory` instances built in
 * `apps/http-api/server/deps.ts` (main process) are unreachable from a
 * coder-worker / company-worker. These shims forward `retrieve` /
 * `extractAndPersist` / `isConfigured` over the MessageBridge to the
 * `memoryRetrieve` / `memoryExtract` / `memoryIsConfigured` handlers
 * registered by `apps/http-api/sse/worker-memory-handlers.ts` — the same
 * single-source-of-truth pattern as the docSearch / vision shims.
 *
 * Failure posture: memory must NEVER break a spawn or a run. Every call
 * degrades to a no-op ([] / skip / not-configured) when the handler is
 * missing, the deps box is empty, or the RPC times out.
 */
// Workers import via relative paths only — Node's loader resolves these
// before tsx/tsconfig `paths` get a chance (see coder-worker.ts header).
import type { MessageBridge } from '../../../packages/orchestrator-host/src/index.js';
import type { InvestigationSemanticIndexPort } from '../../../packages/code-agent/src/tools/investigation-embedder.js';

/** Mirrors the structural `RunCoderOptions.memoryRetriever` item shape. */
export interface ShimRetrievedMemory {
  id: string;
  title: string;
  content: string;
  importance?: number;
  staleNote?: string;
}

/** Mirrors the structural `RunCoderOptions.runEndMemory` input shape. */
export interface ShimRunEndInput {
  primaryRequest?: string;
  summary?: string;
  filesTouched?: string[];
  errorsAndFixes?: string[];
  toolTrail?: string[];
  succeeded?: boolean;
  /** Distill moment for the diagnostics log (compaction | manual_clear | idle). */
  trigger?: string;
  sessionId?: number;
  /** Durable session notes promoted to project-memory candidates. */
  sessionNotes?: Array<{ title: string; body: string; kind: string; pinned: boolean }>;
}

/** Aggregate write counts of one distillation pass (mirrors RunEndMemoryResult). */
export interface ShimRunEndResult {
  created: number;
  merged: number;
  skipped: number;
  /** True when an LLM/transport failure interrupted the pass — the caller must
   *  NOT advance the distill boundary (mirrors RunEndMemoryResult.hadError;
   *  structural-clonable, rides the bridge verbatim). */
  hadError?: boolean;
}

/** Full-content row returned by the explicit recall path (recall_memory tool). */
export interface ShimRecalledMemory extends ShimRetrievedMemory {
  category?: string;
  source?: string;
}

/** Structural match for `RunCoderOptions.memoryRetriever` / `.runEndMemory` / `.projectMemory`. */
export interface WorkerMemoryShims {
  memoryRetriever: {
    retrieve(
      projectId: number,
      projectName: string,
      taskText: string,
    ): Promise<ReadonlyArray<ShimRetrievedMemory>>;
  };
  memoryQuerySynthesizer: (
    tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  ) => Promise<string | null>;
  runEndMemory: {
    extractAndPersist(
      projectId: number,
      projectName: string,
      input: ShimRunEndInput,
    ): Promise<ShimRunEndResult | void>;
    isConfigured(): Promise<boolean>;
  };
  projectMemory: {
    save(
      projectId: number,
      projectName: string,
      entry: { title: string; content: string; category: string },
    ): Promise<ShimRunEndResult | null>;
    recall(
      projectId: number,
      projectName: string,
      query: string,
      limit?: number,
    ): Promise<ShimRecalledMemory[]>;
    list(
      projectId: number,
      projectName: string,
      limit?: number,
      type?: string,
    ): Promise<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>;
    forget(projectId: number, projectName: string, target: string): Promise<{ archived: number }>;
  };
  investigationSemantic: InvestigationSemanticIndexPort;
}

const CONFIGURED_CACHE_MS = 60_000;

export function buildWorkerMemoryShims(bridge: MessageBridge): WorkerMemoryShims {
  // `isConfigured` gates every run's end-of-run summary; cache it so the
  // hot path doesn't pay one RPC per finished run in the same worker.
  let configuredCache: { value: boolean; at: number } | null = null;

  return {
    memoryRetriever: {
      retrieve: async (projectId, projectName, taskText) => {
        try {
          return await bridge.request<ShimRetrievedMemory[]>(
            'memoryRetrieve',
            { projectId, projectName, taskText },
            // Hybrid search + staleness batch is fast; 10s is a stuck-RPC
            // backstop, not an expected latency.
            { timeoutMs: 10_000 },
          );
        } catch {
          return [];
        }
      },
    },
    memoryQuerySynthesizer: async (tail) => {
      try {
        // LLM synthesis runs main-side (8s budget there); 10s is the stuck-RPC
        // backstop. Any failure → null so the runner uses its walk-back heuristic.
        return await bridge.request<string | null>('memoryQuerySynth', { tail }, { timeoutMs: 10_000 });
      } catch {
        return null;
      }
    },
    runEndMemory: {
      extractAndPersist: async (projectId, projectName, input) => {
        try {
          // Distillation runs an LLM pass main-side; the runner already
          // bounds the whole capture at 30s, so this ceiling only guards
          // against a stuck bridge.
          return await bridge.request<ShimRunEndResult | undefined>(
            'memoryExtract',
            { projectId, projectName, input },
            { timeoutMs: 60_000 },
          );
        } catch {
          /* best-effort — distillation loss is acceptable, a crash is not */
          return undefined;
        }
      },
      isConfigured: async () => {
        const now = Date.now();
        if (configuredCache && now - configuredCache.at < CONFIGURED_CACHE_MS) {
          return configuredCache.value;
        }
        let value = false;
        try {
          value = await bridge.request<boolean>('memoryIsConfigured', {}, { timeoutMs: 10_000 });
        } catch {
          value = false;
        }
        configuredCache = { value, at: now };
        return value;
      },
    },
    projectMemory: {
      save: async (projectId, projectName, entry) => {
        try {
          // Write path embeds + dedups main-side; generous ceiling for the
          // embedding round-trip, still bounded against a stuck bridge.
          return await bridge.request<ShimRunEndResult | null>(
            'memorySave',
            { projectId, projectName, entry },
            { timeoutMs: 15_000 },
          );
        } catch {
          return null; // tool surfaces "not available" — never crash the run
        }
      },
      recall: async (projectId, projectName, query, limit) => {
        try {
          return await bridge.request<ShimRecalledMemory[]>(
            'memoryRecall',
            { projectId, projectName, query, limit },
            { timeoutMs: 10_000 },
          );
        } catch {
          return [];
        }
      },
      list: async (projectId, projectName, limit, type) => {
        try {
          return await bridge.request<Array<{ name: string; description: string; type: string; importance: number; created_at: string }>>(
            'memoryList',
            { projectId, projectName, limit, type },
            { timeoutMs: 10_000 },
          );
        } catch {
          return [];
        }
      },
      forget: async (projectId, projectName, target) => {
        try {
          return await bridge.request<{ archived: number }>(
            'memoryForget',
            { projectId, projectName, target },
            { timeoutMs: 10_000 },
          );
        } catch {
          return { archived: 0 };
        }
      },
    },
    investigationSemantic: {
      wakeUpsert: (record) => {
        // SessionStore already persisted the durable pre-write fence in this
        // worker. RPC is only a low-latency wake-up for the main coordinator.
        void bridge.request('investigationWake', record, { timeoutMs: 10_000 })
          .catch(() => undefined);
      },
      search: async (input) => {
        try {
          return await bridge.request<number[]>('investigationSearch', input, { timeoutMs: 10_000 });
        } catch {
          return [];
        }
      },
    },
  };
}
