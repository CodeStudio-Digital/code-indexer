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
 * Read/injection paths remain best-effort. Mutating paths are different:
 * a timeout has an unknown outcome because the host may still commit. They
 * reconcile by operation id and surface an explicit error instead of lying
 * that a write succeeded or automatically replaying it.
 */
// Workers import via relative paths only — Node's loader resolves these
// before tsx/tsconfig `paths` get a chance (see coder-worker.ts header).
import { randomUUID } from 'node:crypto';
import {
  isMutationOutcomeUnknownError,
  type MessageBridge,
} from '../../../packages/orchestrator-host/src/index.js';
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
const MEMORY_SAVE_TIMEOUT_MS = 15_000;
const MEMORY_SAVE_RECONCILE_MS = 45_000;
const MEMORY_SAVE_STATUS_POLL_MS = 250;

type MemorySaveStatus =
  | { state: 'unknown' | 'pending' }
  | { state: 'completed'; result: ShimRunEndResult }
  | { state: 'failed'; error: string; code?: string };
type MemoryForgetStatus =
  | { state: 'unknown' | 'pending' }
  | { state: 'completed'; result: { archived: number } }
  | { state: 'failed'; error: string; code?: string };

export class MemorySaveOutcomeUnknownError extends Error {
  readonly code = 'memory_save_outcome_unknown';

  constructor(readonly operationId: string, cause?: unknown) {
    super(
      `Project memory save outcome is unknown (operation ${operationId}). `
      + `The host may still complete it; do not repeat automatically.`
      + (cause instanceof Error ? ` ${cause.message}` : ''),
    );
    this.name = 'MemorySaveOutcomeUnknownError';
  }
}

export class MemoryForgetOutcomeUnknownError extends Error {
  readonly code = 'memory_forget_outcome_unknown';

  constructor(readonly operationId: string, cause?: unknown) {
    super(
      `Project memory archive outcome is unknown (operation ${operationId}). `
      + `The host may still complete it; do not repeat automatically.`
      + (cause instanceof Error ? ` ${cause.message}` : ''),
    );
    this.name = 'MemoryForgetOutcomeUnknownError';
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

async function reconcileMemorySave(
  bridge: MessageBridge,
  operationId: string,
  cause: unknown,
): Promise<ShimRunEndResult> {
  const deadline = Date.now() + MEMORY_SAVE_RECONCILE_MS;
  while (Date.now() < deadline) {
    await wait(MEMORY_SAVE_STATUS_POLL_MS);
    let status: MemorySaveStatus;
    try {
      status = await bridge.request<MemorySaveStatus>(
        'memorySaveStatus',
        { operationId },
        { timeoutMs: 5_000 },
      );
    } catch (statusError) {
      if (isMutationOutcomeUnknownError(statusError)) {
        throw new MemorySaveOutcomeUnknownError(operationId, cause);
      }
      continue;
    }
    if (status.state === 'completed') return status.result;
    if (status.state === 'failed') {
      const error = Object.assign(new Error(status.error), {
        code: status.code ?? 'memory_save_failed',
      });
      throw error;
    }
  }
  throw new MemorySaveOutcomeUnknownError(operationId, cause);
}

async function reconcileMemoryForget(
  bridge: MessageBridge,
  operationId: string,
  cause: unknown,
): Promise<{ archived: number }> {
  const deadline = Date.now() + MEMORY_SAVE_RECONCILE_MS;
  while (Date.now() < deadline) {
    await wait(MEMORY_SAVE_STATUS_POLL_MS);
    let status: MemoryForgetStatus;
    try {
      status = await bridge.request<MemoryForgetStatus>(
        'memoryForgetStatus',
        { operationId },
        { timeoutMs: 5_000 },
      );
    } catch (statusError) {
      if (isMutationOutcomeUnknownError(statusError)) {
        throw new MemoryForgetOutcomeUnknownError(operationId, cause);
      }
      continue;
    }
    if (status.state === 'completed') return status.result;
    if (status.state === 'failed') {
      throw Object.assign(new Error(status.error), {
        code: status.code ?? 'memory_forget_failed',
      });
    }
  }
  throw new MemoryForgetOutcomeUnknownError(operationId, cause);
}

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
        const operationId = randomUUID();
        try {
          return await bridge.request<ShimRunEndResult>(
            'memorySave',
            { operationId, projectId, projectName, entry },
            { timeoutMs: MEMORY_SAVE_TIMEOUT_MS },
          );
        } catch (error) {
          if (isMutationOutcomeUnknownError(error)) {
            return reconcileMemorySave(bridge, operationId, error);
          }
          throw error;
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
        const operationId = randomUUID();
        try {
          return await bridge.request<{ archived: number }>(
            'memoryForget',
            { operationId, projectId, projectName, target },
            { timeoutMs: MEMORY_SAVE_TIMEOUT_MS },
          );
        } catch (error) {
          if (isMutationOutcomeUnknownError(error)) {
            return reconcileMemoryForget(bridge, operationId, error);
          }
          throw error;
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
