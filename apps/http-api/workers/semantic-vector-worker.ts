import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageBridge,
  type MessageBridgeOpts,
} from '../../../packages/orchestrator-host/src/index.js';
import { CodeIndexDB } from '../../../packages/store/src/db.js';
import { SemanticStore } from '../../../packages/store/src/semantic-store.js';
import { LocalVectorRouter } from '../../../packages/store/src/local-vector-router.js';
import type { VectorRecord } from '../../../packages/shared/src/types.js';
import type {
  VectorSearchOptions,
  VectorWriteTarget,
} from '../../../packages/store/src/vectors.js';
import { registerPerfStatsHandler } from './perf-stats.js';
import { LocalEmbeddingService } from '../../../packages/indexer/src/search/local-embeddings.js';
import { LocalReranker } from '../../../packages/indexer/src/search/local-reranker.js';
import { resolveOnnxIdleTtlMs } from '../../../packages/indexer/src/search/onnx-idle.js';
import {
  resolveLocalReranker,
  resolvedRerankDepth,
  type ResolvedLocalReranker,
} from '../../../packages/indexer/src/search/local-reranker-policy.js';
import { SemanticInferenceScheduler } from '../../../packages/indexer/src/search/semantic-inference-scheduler.js';
import type { RerankCandidate } from '../../../packages/indexer/src/search/reranker-types.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
} from '../../../packages/store/src/semantic-store.js';

const port = parentPort;
if (!port) throw new Error('semantic-vector-worker: not running inside a worker_thread');
const { dbPath } = workerData as { dbPath: string };
const db = new CodeIndexDB(dbPath);
const semanticStore = new SemanticStore(db.raw());
const router = new LocalVectorRouter({
  resolveProject: (projectId) => db.getProject(projectId),
  semanticStore,
  maxOpen: 8,
  idleTtlMs: 60_000,
});
router.pool.startSweeper();
const vectors = router.asVectorStore();
const inference = new SemanticInferenceScheduler();
const INFERENCE_SESSION_IDLE_MS = resolveOnnxIdleTtlMs();
const INFERENCE_SESSION_SWEEP_MS = 60_000;
let activeOperations = 0;
type WorkerEmbeddingSession = {
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
  embedQuery(text: string): Promise<{ vector: number[]; tokens: number }>;
  dispose(): Promise<void>;
};
type ManagedInferenceSession<T> = {
  service: T;
  lastUsedAt: number;
  inflight: number;
};
const embeddingSessions = new Map<string, ManagedInferenceSession<WorkerEmbeddingSession>>();
const rerankerSessions = new Map<string, ManagedInferenceSession<LocalReranker>>();
const lastRerankLatencyMs = new Map<string, number>();

async function trackOperation<T>(run: () => Promise<T> | T): Promise<T> {
  activeOperations++;
  try { return await run(); }
  finally { activeOperations--; }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => `${JSON.stringify(name)}:${stable(entry)}`)
    .join(',')}}`;
}

function normalizeVector(vector: number[]): number[] {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('local embedding returned an empty or non-finite vector');
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('local embedding returned a zero vector');
  return vector.map((value) => value / norm);
}

function rerankerTargetKey(target: Extract<RerankerTarget, { kind: 'onnx' }>): string {
  return stable({ ...target, dtype: target.dtype ?? 'q8' as const });
}

function embeddingFor(target: EmbeddingTarget): ManagedInferenceSession<WorkerEmbeddingSession> {
  if (target.kind !== 'onnx') throw new Error('semantic worker only executes ONNX embeddings');
  const effective = { ...target, dtype: target.dtype ?? 'q8' as const };
  const key = stable(effective);
  let managed = embeddingSessions.get(key);
  if (!managed) {
    const local = new LocalEmbeddingService({
      model: target.model,
      revision: target.revision,
      cacheDir: target.cacheDir,
      dtype: target.dtype ?? 'q8',
      protocol: {
        pooling: target.pooling,
        normalize: true,
        queryTemplate: target.queryTemplate,
        documentTemplate: target.documentTemplate,
        maxTokens: target.maxTokens,
      },
    });
    const service: WorkerEmbeddingSession = {
      async embed(texts) {
        const result = await local.embed(texts);
        return { ...result, vectors: result.vectors.map(normalizeVector) };
      },
      async embedQuery(text) {
        const result = await local.embedQuery(text);
        return { ...result, vector: normalizeVector(result.vector) };
      },
      dispose: () => local.dispose(),
    };
    managed = { service, lastUsedAt: Date.now(), inflight: 0 };
    embeddingSessions.set(key, managed);
  }
  managed.lastUsedAt = Date.now();
  return managed;
}

function resolvedRerankerFor(target: Extract<RerankerTarget, { kind: 'onnx' }>): {
  resolved: ResolvedLocalReranker;
  managed: ManagedInferenceSession<LocalReranker>;
} {
  // Re-evaluate available memory before every inference. A previous automatic
  // decision must not pin a heavy model after the machine becomes constrained.
  const resolved = resolveLocalReranker(target);
  if (!resolved.enabled || !resolved.model) {
    throw new Error(resolved.downgradeReason ?? 'local reranker unavailable');
  }
  const sessionKey = stable({
    model: resolved.model,
    dtype: resolved.dtype,
    revision: target.revision,
    cacheDir: target.cacheDir,
    maxTokens: target.maxTokens,
    executionProvider: resolved.executionProvider,
  });
  let managed = rerankerSessions.get(sessionKey);
  if (!managed) {
    const service = new LocalReranker({
      model: resolved.model,
      revision: target.revision,
      cacheDir: target.cacheDir,
      dtype: resolved.dtype,
      maxTokens: target.maxTokens,
      executionProvider: resolved.executionProvider,
      strict: true,
    });
    managed = { service, lastUsedAt: Date.now(), inflight: 0 };
    rerankerSessions.set(sessionKey, managed);
  }
  managed.lastUsedAt = Date.now();
  return { resolved, managed };
}

async function sweepIdleInferenceSessions(now = Date.now()): Promise<void> {
  // The shared ONNX idle contract uses 0 to mean "keep resident until worker
  // shutdown". Do not let this outer registry invert that override while the
  // inner service leases correctly honor it.
  if (INFERENCE_SESSION_IDLE_MS <= 0) return;
  const disposals: Promise<void>[] = [];
  for (const [key, managed] of embeddingSessions) {
    if (managed.inflight > 0 || now - managed.lastUsedAt < INFERENCE_SESSION_IDLE_MS) continue;
    embeddingSessions.delete(key);
    disposals.push(managed.service.dispose());
  }
  for (const [key, managed] of rerankerSessions) {
    if (managed.inflight > 0 || now - managed.lastUsedAt < INFERENCE_SESSION_IDLE_MS) continue;
    rerankerSessions.delete(key);
    disposals.push(managed.service.dispose());
  }
  if (disposals.length > 0) await Promise.allSettled(disposals);
}

const inferenceSessionSweep = INFERENCE_SESSION_IDLE_MS > 0
  ? setInterval(() => { void sweepIdleInferenceSessions(); }, INFERENCE_SESSION_SWEEP_MS)
  : null;
inferenceSessionSweep?.unref?.();

async function disposeInference(): Promise<void> {
  if (inferenceSessionSweep) clearInterval(inferenceSessionSweep);
  inference.close();
  await Promise.allSettled([
    ...[...embeddingSessions.values()].map(({ service }) => service.dispose()),
    ...[...rerankerSessions.values()].map(({ service }) => service.dispose()),
  ]);
  embeddingSessions.clear();
  rerankerSessions.clear();
  lastRerankLatencyMs.clear();
}

function rerankerDiagnosticsPayload(resolved: ResolvedLocalReranker, requestedKey: string) {
  return {
    policy: resolved.policy,
    requested_model: resolved.requestedModel,
    resolved_model: resolved.model,
    dtype: resolved.dtype,
    estimated_peak_bytes: resolved.estimatedPeakBytes,
    reserve_bytes: resolved.reserveBytes,
    execution_provider: resolved.executionProvider,
    downgrade_reason: resolved.downgradeReason,
    last_latency_ms: lastRerankLatencyMs.get(requestedKey) ?? null,
    enabled: resolved.enabled,
    total_memory_bytes: resolved.hardware.totalMemoryBytes,
    available_memory_bytes: resolved.hardware.availableMemoryBytes,
    cpu_cores: resolved.hardware.cpuCores,
    ...inference.diagnostics(),
  };
}

const bridge = new MessageBridge({
  port: port as unknown as MessageBridgeOpts['port'],
  onListenerError: (error, context) =>
    console.warn(`[semantic-vector-worker] listener error in ${context}:`, error),
});
registerPerfStatsHandler(bridge);

bridge.handle('inference.embed', async (payload) => {
  const { target, texts } = payload as { target: EmbeddingTarget; texts: string[] };
  return trackOperation(() => inference.enqueue(0, async () => {
    const managed = embeddingFor(target);
    managed.inflight++;
    try { return await managed.service.embed(texts); }
    finally {
      managed.inflight--;
      managed.lastUsedAt = Date.now();
    }
  }));
});
bridge.handle('inference.embedQuery', async (payload) => {
  const { target, text } = payload as { target: EmbeddingTarget; text: string };
  return trackOperation(() => inference.enqueue(100, async () => {
    const managed = embeddingFor(target);
    managed.inflight++;
    try { return await managed.service.embedQuery(text); }
    finally {
      managed.inflight--;
      managed.lastUsedAt = Date.now();
    }
  }));
});
bridge.handle('inference.rerank', async (payload) => {
  const input = payload as {
    target: RerankerTarget;
    query: string;
    candidates: RerankCandidate[];
    topK: number;
    supersessionKey?: string;
  };
  if (input.target.kind !== 'onnx') throw new Error('semantic worker only executes ONNX rerankers');
  const target = input.target;
  return trackOperation(() => inference.enqueue(100, async () => {
    const { resolved, managed } = resolvedRerankerFor(target);
    const requestedKey = rerankerTargetKey(target);
    const depth = resolvedRerankDepth(resolved, input.topK, input.candidates.length);
    const started = Date.now();
    managed.inflight++;
    const results = await managed.service.rerank(
      input.query,
      input.candidates.slice(0, depth),
      input.topK,
    ).finally(() => {
      managed.inflight--;
      managed.lastUsedAt = Date.now();
      lastRerankLatencyMs.set(requestedKey, Date.now() - started);
    });
    return { results, diagnostics: rerankerDiagnosticsPayload(resolved, requestedKey) };
  }, { supersessionKey: input.supersessionKey }));
});
bridge.handle('inference.rerankerDiagnostics', async (payload) => {
  const { target } = payload as { target: RerankerTarget };
  if (target.kind !== 'onnx') return null;
  const requestedKey = rerankerTargetKey(target);
  const resolved = resolveLocalReranker(target);
  return rerankerDiagnosticsPayload(resolved, requestedKey);
});
bridge.handle('worker.idleState', async () => ({
  activeOperations,
  ...inference.diagnostics(),
}));

bridge.handle('vectors.upsert', async (payload) => {
  const input = payload as {
    records: VectorRecord[];
    namespace: string;
    writeTarget?: VectorWriteTarget;
  };
  return trackOperation(() => vectors.upsert(input.records, input.namespace, input.writeTarget));
});
bridge.handle('vectors.search', async (payload) => {
  const input = payload as {
    queryVector: number[];
    options: VectorSearchOptions & { namespace: string };
  };
  return trackOperation(() => vectors.search(input.queryVector, input.options));
});
bridge.handle('vectors.deleteByIds', async (payload) => {
  const input = payload as { ids: string[]; namespace: string; writeTarget?: VectorWriteTarget };
  return trackOperation(() => vectors.deleteByIds(input.ids, input.namespace, input.writeTarget));
});
bridge.handle('vectors.listItems', async (payload) => {
  const input = payload as {
    namespace: string;
    itemKeys?: string[];
    writeTarget?: VectorWriteTarget;
  };
  return trackOperation(() =>
    vectors.listItems?.(input.namespace, input.itemKeys, input.writeTarget) ?? []);
});
bridge.handle('vectors.deleteByItemKeys', async (payload) => {
  const input = payload as { itemKeys: string[]; namespace: string };
  return trackOperation(() => vectors.deleteByItemKeys?.(input.itemKeys, input.namespace) ?? 0);
});
bridge.handle('vectors.deleteNamespace', async (payload) => {
  const { namespace } = payload as { namespace: string };
  return trackOperation(() => vectors.deleteNamespace?.(namespace) ?? 0);
});
bridge.handle('vectors.available', async () => true);
bridge.handle('vectors.removeProject', async (payload) => {
  await trackOperation(() => router.removeProject((payload as { projectId: number }).projectId));
  return undefined;
});
bridge.handle('vectors.dropGeneration', async (payload) => {
  const { namespace, generationId } = payload as { namespace: string; generationId: number };
  await trackOperation(() => router.dropGeneration(namespace, generationId));
  return undefined;
});
bridge.handle('vectors.hasGeneration', async (payload) => {
  const { namespace, generationId } = payload as { namespace: string; generationId: number };
  return trackOperation(() => router.hasGeneration(namespace, generationId));
});
bridge.handle('vectors.compactGenerationDatabase', async (payload) => {
  const { namespace, generationId } = payload as { namespace: string; generationId: number };
  return trackOperation(() => router.compactGenerationDatabase(namespace, generationId));
});
bridge.handle('vectors.listIds', async (payload) => {
  const { namespace, generationId } = payload as { namespace: string; generationId: number };
  return trackOperation(() => router.listIds(namespace, generationId));
});
bridge.handle('vectors.deleteByIdsForGeneration', async (payload) => {
  const { namespace, generationId, ids } = payload as {
    namespace: string; generationId: number; ids: string[];
  };
  return trackOperation(() => router.deleteByIds(namespace, generationId, ids));
});
bridge.handle('vectors.deleteByItemKeysForGeneration', async (payload) => {
  const { namespace, generationId, itemKeys } = payload as {
    namespace: string; generationId: number; itemKeys: string[];
  };
  return trackOperation(() => router.deleteByItemKeys(namespace, generationId, itemKeys));
});
bridge.handle('stop', async () => {
  await disposeInference();
  await router.drainAndClose();
  db.close();
  setImmediate(() => process.exit(0));
  return { ok: true };
});

process.on('exit', () => {
  if (inferenceSessionSweep) clearInterval(inferenceSessionSweep);
  inference.close();
  router.close();
  try { db.close(); } catch { /* already closed */ }
});
process.on('uncaughtException', (error) => {
  console.error('[semantic-vector-worker] uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[semantic-vector-worker] unhandled rejection:', error);
  process.exit(1);
});

bridge.emit('worker.ready', {});
