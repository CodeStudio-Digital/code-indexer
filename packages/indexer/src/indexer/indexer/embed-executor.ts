import type { CodeIndexDB } from '@mcp/store/db.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { CostTracker } from '@mcp/services/services/costs.js';
import type { VectorRecord } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { safeJsonArray } from '@mcp/shared/utils/safe-json.js';
import type { LshIndexingSink } from '@mcp/indexer/indexer/lsh-indexing-sink.js';
import type { LLMFileAnalysis } from '@mcp/shared/types.js';

import {
  buildEmbeddingCandidates,
  type CandidateFile,
  type EmbeddingCandidate,
} from './embedding-candidates.js';
import { resolveEmbedConcurrency, runEmbedChunks } from './embed-parallel.js';

export interface EmbedExecutorDeps {
  db: CodeIndexDB;
  embeddingService: EmbeddingService;
  vectorStore: VectorStore | null;
  costTracker: CostTracker;
  lshSink: LshIndexingSink;
  indexProfile?: 'aggressive' | 'balanced' | 'conservative';
}

/**
 * Provider/model labels for cost rows, derived from the service fingerprint
 * (`cloudflare:bge-m3`, `local:Xenova/…`, `bedrock:amazon.titan…`). Hardcoding
 * cloudflare/bge-m3 here made cost history lie whenever the embedder was
 * local or Bedrock. The Cloudflare label keeps its historical model id so
 * existing cost series and model_prices rows still line up.
 */
function embeddingCostIdentity(service: EmbeddingService): { provider: string; model: string } {
  const fp = service.fingerprint?.() ?? 'embedding:unknown';
  if (fp === 'cloudflare:bge-m3') return { provider: 'cloudflare', model: '@cf/baai/bge-m3' };
  const sep = fp.indexOf(':');
  return sep > 0
    ? { provider: fp.slice(0, sep), model: fp.slice(sep + 1) }
    : { provider: fp, model: fp };
}

export interface ExecuteEmbeddingResult {
  /** Embedding tokens consumed, for cost accounting. */
  tokens: number;
  /** Records the LSH sink failed to index (best-effort, but counted). */
  lshFailed: number;
}

/**
 * Embed candidates and upsert to vector store. Shared by `processEmbeddings`
 * (after LLM analysis) and `retryEmbeddings` (DB+disk path).
 *
 * Ordering invariant: vector upsert → vector_ids save → LSH sink →
 * `onCommit()` (hash write) LAST — a candidate's hash is only persisted
 * after its vectors verifiably landed.
 */
export async function executeEmbedding(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number | null,
  candidates: EmbeddingCandidate[],
): Promise<ExecuteEmbeddingResult> {
  if (!deps.vectorStore) throw new Error('vectorStore is required for executeEmbedding');
  const { vectors, tokens } = await deps.embeddingService.embed(candidates.map((c) => c.text));

  if (runId !== null) {
    const identity = embeddingCostIdentity(deps.embeddingService);
    deps.costTracker.record({
      projectId: project.id,
      runId,
      provider: identity.provider,
      model: identity.model,
      operation: 'embedding',
      inputTokens: tokens,
      outputTokens: 0,
    });
  }

  const vectorRecords: VectorRecord[] = candidates.map((c, i) => ({
    id: c.id,
    values: vectors[i],
    metadata: c.metadata,
  }));

  // Isolate by project namespace so another project's code never pollutes
  // this project's search top-K (and a project delete can drop it wholesale).
  await deps.vectorStore.upsert(vectorRecords, codeNamespace(project.name));

  deps.db.saveVectorIds(
    project.id,
    candidates.map((c) => ({
      vectorId: c.id,
      filePath: c.filePath,
      type: c.metadata.type as 'file' | 'symbol' | 'symbol_body',
    })),
  );

  // LSH bucket sink. Optional — default is no-op. When `RealLshIndexingSink`
  // is wired this populates `embedding_simhash_signatures` + `_lsh_buckets`
  // alongside the vector store so the hybrid search can narrow candidates
  // via integer bucket lookup before doing full-precision cosine.
  let lshFailed = 0;
  try {
    await deps.lshSink.afterUpsert(project.id, vectorRecords);
  } catch (err) {
    // LSH is best-effort — indexing continues — but a silently asymmetric
    // LSH index degrades hybrid search, so the failure is counted and logged.
    lshFailed = vectorRecords.length;
    console.warn(`[indexer] LSH sink failed for ${vectorRecords.length} record(s): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stale extra windows (bodies that shrank from N to M chunks). Deleted
  // only after the replacement windows upserted; remote failure → tombstone
  // queue. The local vector_ids rows go either way.
  const superseded = candidates.flatMap((c) => c.supersededIds ?? []);
  if (superseded.length > 0) {
    try {
      await deps.vectorStore.deleteByIds(superseded, codeNamespace(project.name));
    } catch (err) {
      deps.db.enqueuePendingVectorDeletes(superseded.map((vector_id) => ({
        vector_id,
        project_name: project.name,
        error: err instanceof Error ? err.message : String(err),
      })));
    }
    deps.db.deleteVectorIdRows(project.id, superseded);
  }

  for (const c of candidates) c.onCommit();
  return { tokens, lshFailed };
}

export interface IndexedFileEntry {
  path: string;
  fileId: number;
  analysis: LLMFileAnalysis;
  content: string;
  tier?: 'core' | 'support' | 'on_demand';
}

const EMBED_CHUNK_SIZE = 50;

/**
 * Process embeddings for files that were just LLM-analyzed in this run.
 *
 * The "aggressive" index profile skips embeddings for `on_demand` files
 * (tests, docs, migrations, fixtures). They stay searchable via FTS but no
 * longer consume embedding tokens. Files without a tier (legacy pre-071) are
 * treated as `support` and embedded.
 */
export async function processEmbeddings(
  deps: EmbedExecutorDeps,
  project: { id: number; name: string },
  runId: number,
  indexedFiles: IndexedFileEntry[],
): Promise<void> {
  const profile = deps.indexProfile ?? 'balanced';
  const skipped: string[] = [];
  const eligible = indexedFiles.filter((f) => {
    if (profile === 'aggressive' && f.tier === 'on_demand') {
      skipped.push(f.path);
      return false;
    }
    return true;
  });

  if (skipped.length > 0) {
    console.error(`[indexer] Skipping ${skipped.length} on_demand embedding(s) (aggressive profile)`);
  }

  const files: CandidateFile[] = eligible.map((f) => ({
    path: f.path,
    fileId: f.fileId,
    language: f.analysis.language,
    summary: f.analysis.summary,
    concepts: f.analysis.concepts,
    symbols: f.analysis.symbols,
    content: f.content,
  }));

  const candidates = buildEmbeddingCandidates(deps.db, project, files);

  if (candidates.length === 0) {
    console.error('[indexer] All embeddings up to date — skipping embed pipeline');
    return;
  }

  const concurrency = resolveEmbedConcurrency(deps.embeddingService);
  console.error(`[indexer] Embedding ${candidates.length} new/changed records (concurrency ${concurrency})`);
  const res = await runEmbedChunks(candidates, {
    chunkSize: EMBED_CHUNK_SIZE,
    concurrency,
    execute: (chunk) => executeEmbedding(deps, project, runId, chunk),
  });
  if (res.lshFailed > 0) {
    console.warn(`[indexer] LSH sink failed for ${res.lshFailed} record(s) this run — hybrid pre-filter will be partial until a re-embed`);
  }
  if (res.failures.length > 0) {
    // Sibling chunks already finished (their hashes committed); the failed
    // chunks' candidates re-emit next run. Throw one aggregate error so the
    // run is marked completed_with_errors instead of a silent green.
    throw new Error(
      `Embedding failed for ${res.failures.length} batch(es) — ${res.embedded}/${candidates.length} records embedded. First error: ${res.failures[0].error}`,
    );
  }
}

export interface EmbeddingProgress { current: number; total: number; percent: number }
export interface EmbeddingRetryResult {
  embedded: number;
  skipped: number;
  tokens: number;
  /** Batches that failed (their candidates' hashes never committed — a re-run picks them up). */
  failedBatches: number;
}

/**
 * Retry embedding for all files in a project that have missing or outdated
 * embedding hashes. Reads file metadata from DB and content from disk — no
 * LLM analysis needed.
 */
export async function retryEmbeddings(
  deps: EmbedExecutorDeps,
  projectNameOrPath: string,
  options?: {
    onProgress?: (p: EmbeddingProgress) => void;
    /** Attribute embedding cost to an index run (model-change sweep). Default: untracked. */
    runId?: number | null;
  },
): Promise<EmbeddingRetryResult> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const vectorsAvailable = deps.vectorStore && !(deps.embeddingService instanceof NullEmbeddingService)
    ? await deps.vectorStore.isAvailable()
    : false;
  if (!vectorsAvailable || !deps.vectorStore) {
    throw new Error('Embedding service or vector store not available');
  }

  const project = deps.db.resolveProject(undefined, projectNameOrPath) ?? deps.db.resolveProject(projectNameOrPath);
  const dbFiles = deps.db.listFiles(project.id);

  const files: CandidateFile[] = [];
  for (const dbFile of dbFiles) {
    let content: string;
    try { content = readFileSync(join(project.root_path, dbFile.path), 'utf-8'); }
    catch { continue; }  // file removed from disk — skip

    const dbSymbols = deps.db.getSymbolsByFile(project.id, dbFile.path);
    files.push({
      path: dbFile.path,
      fileId: dbFile.id,
      language: dbFile.language,
      summary: dbFile.summary,
      concepts: safeJsonArray<string>(dbFile.concepts),
      symbols: dbSymbols.map((s) => ({ name: s.name, kind: s.kind, signature: s.signature, comment: s.comment, line: s.line })),
      content,
    });
  }

  const candidates = buildEmbeddingCandidates(deps.db, project, files);
  const total = candidates.length;

  if (total === 0) {
    options?.onProgress?.({ current: 0, total: 0, percent: 100 });
    return { embedded: 0, skipped: dbFiles.length, tokens: 0, failedBatches: 0 };
  }

  console.error(`[indexer] Retry embedding: ${total} candidates from ${files.length} files`);

  const res = await runEmbedChunks(candidates, {
    chunkSize: EMBED_CHUNK_SIZE,
    concurrency: resolveEmbedConcurrency(deps.embeddingService),
    execute: (chunk) => executeEmbedding(deps, project, options?.runId ?? null, chunk),
    // Progress counts completions, so it stays monotonic regardless of the
    // order concurrent chunks finish in.
    onChunkDone: ({ embedded }) =>
      options?.onProgress?.({ current: embedded, total, percent: Math.round((embedded / total) * 100) }),
  });
  if (res.lshFailed > 0) {
    console.warn(`[indexer] LSH sink failed for ${res.lshFailed} record(s) during retry`);
  }
  if (res.failures.length > 0) {
    console.warn(
      `[indexer] ${res.failures.length} embedding batch(es) failed during retry — ${res.embedded}/${total} embedded; run again to pick up the rest (first error: ${res.failures[0].error})`,
    );
  }

  return { embedded: res.embedded, skipped: dbFiles.length - files.length, tokens: res.tokens, failedBatches: res.failures.length };
}
